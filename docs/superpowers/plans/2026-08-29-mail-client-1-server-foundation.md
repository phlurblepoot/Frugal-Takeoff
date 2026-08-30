# Mail Client — Plan 1 of 4: Server Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side mail subsystem — encrypted account store, envelope index (migration 31), thread-key engine, provider interface with an in-memory fake, sync engine + scheduler, sanitizer, `/api/mail/*` routes, `sendService` with thread links, and rewire the seven item send routes onto it — all testable without any real mail provider.

**Architecture:** Everything lives under `server/mail/` and is wired into `server.ts` through one `registerMailRoutes(app, deps)` call plus a `MailScheduler` instance. Providers implement `MailProvider`; this plan ships only `providers/fake.ts` (Plan 2 adds IMAP/Google/Microsoft). The sync engine writes `mail_messages`/`mail_threads`/`mail_folders` and broadcasts `mailThread`/`mailAccount` change-feed events. `sendService.send` is the single outbound path used by `/api/mail/send` and the seven item routes.

**Tech Stack:** Node 20 + TypeScript (ESM, `tsx`), Express 4, better-sqlite3, vitest (`server` project), supertest, Node `crypto` (AES-256-GCM), `dompurify` + `jsdom` (sanitizer), `uuid`.

**Spec:** `docs/superpowers/specs/2026-08-29-mail-client-design.md` (§3 data model, §4 server, §4.5 sendService, §4.6 item send effects, §7 security, §9 testing).

## Global Constraints

- Migration number is **31**; `server/migrationList.ts` last entry is version 30 (`updated-at-columns`). One migration for all §3 tables + `rfis` columns + SMTP transform.
- No secure-context/browser-only APIs anywhere (memory: `no-secure-context-apis`). Use the `uuid` package (`import { v4 as uuidv4 } from 'uuid'`) for ids on both client and server.
- `journal_mode = DELETE` is deliberate (`server/db.ts`); do not change.
- Never return `authBlob` (or anything decrypted from it) from any route.
- Every `/api/mail/*` route is `authenticateToken`-gated and scoped to `mail_accounts.userId = req.user.id`.
- Route modules take a deps object (`registerMailRoutes(app, deps)`) so supertest tests inject stubs — follow `registerEmailRoutes` in `server/routes.ts:1592-1700`.
- Tests: `npm test -- --project server` runs vitest server project; `npm run lint` = `tsc --noEmit` must stay clean.
- Commit after every task; push to `testing` at the end of the plan (project CLAUDE.md: always push to `testing`).
- Encryption key: env `MAIL_SECRET_KEY` (hex or base64, 32 bytes) else `data/mail.key` auto-generated with mode 0600.

## Shared interface contract (used by all four plans)

```ts
// server/mail/providers/types.ts
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
  send(msg: OutgoingMessage): Promise<{ providerMessageId: string; providerThreadId?: string }>;
  setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }): Promise<void>;
  move(ids: string[], folderProviderId: string): Promise<void>;
  archive(ids: string[]): Promise<void>;
  trash(ids: string[]): Promise<void>;
  saveDraft(draft: OutgoingMessage, existingProviderId?: string): Promise<{ providerMessageId: string }>;
  deleteDraft(providerMessageId: string): Promise<void>;
  search(query: string, opts: { before?: Date; limit: number }): Promise<Envelope[]>;
}
export class AuthExpiredError extends Error {}
export class RateLimitedError extends Error { retryAfterMs = 60_000 }
export class ProviderNotFoundError extends Error {}
```

```ts
// server/mail/accountStore.ts  (public surface)
export interface MailAccountRow { id; userId; provider; emailAddress; displayName; signatureHtml; isDefault; syncState; indexedSince; status; lastSyncAt; lastError; createdAt; updatedAt }  // all string|number|null, NO authBlob
export type ImapAuth = { imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean; username: string; password: string };
export type OAuthAuth = { refreshToken: string };
export function listAccounts(db, userId): MailAccountRow[]
export function getOwned(db, userId, accountId): MailAccountRow | null
export function getAccountAny(db, accountId): MailAccountRow | null            // scheduler use
export function listActiveAccounts(db): MailAccountRow[]                       // status in ('ok','syncing')
export function createAccount(db, crypto, input: { userId; provider; emailAddress; displayName?; auth: ImapAuth|OAuthAuth; status?; indexedSince? }): MailAccountRow
export function updateAccount(db, accountId, patch: Partial<Pick<MailAccountRow,'displayName'|'signatureHtml'|'status'|'lastSyncAt'|'lastError'|'syncState'|'indexedSince'>>): void
export function updateAuth(db, crypto, accountId, auth: ImapAuth|OAuthAuth): void
export function readAuth(db, crypto, accountId): ImapAuth|OAuthAuth|null       // providers only
export function setDefault(db, userId, accountId): void
export function deleteAccount(db, accountId): void
```

```ts
// server/mail/sendService.ts
export type ItemType = 'proposal'|'invoice'|'changeOrder'|'payApp'|'issue'|'rfi'|'dailyReport'|'punch'|'task'|'project'|'customer';
export interface SendRequest {
  accountId?: string; to: Addr[]; cc?: Addr[]; bcc?: Addr[]; subject: string; html: string;
  attachments: Array<{ fileId: string; name?: string; itemType?: ItemType; itemId?: string } | { uploadId: string }>;
  replyTo?: { accountId: string; threadKey: string };
  links?: Array<{ itemType: ItemType; itemId: string }>;
  draftProviderId?: string;
}
export interface SendResult { messageId: string; threadKey: string; accountId: string; effectsSkipped: ItemType[] }
export async function send(ctx: MailContext, user: { id: string; role: string }, req: SendRequest): Promise<SendResult>
```

```ts
// server/mail/context.ts — the one object every mail module receives
export interface MailContext {
  db: Database.Database; dataDir: string; crypto: MailCrypto;
  providerFactory: (account: MailAccountRow, auth: ImapAuth|OAuthAuth) => MailProvider;
  broadcastChange: BroadcastChange;
  scheduler?: MailScheduler;           // undefined in pure unit tests
}
```

Change-feed additions (server `server/realtime/changeFeed.ts` and client `src/hooks/useLiveQuery.ts` `EntityType`): `'mailThread' | 'mailAccount'`.

---

## File map

| File | Responsibility |
|---|---|
| `server/mail/crypto.ts` | `MailCrypto` seal/open + key resolution |
| `server/mail/context.ts` | `MailContext` type |
| `server/mail/accountStore.ts` | mail_accounts CRUD, sealed auth |
| `server/mail/threadKey.ts` | normalization + References walk + merge |
| `server/mail/providers/types.ts` | contract above |
| `server/mail/providers/fake.ts` | in-memory provider for tests/E2E |
| `server/mail/mime.ts` | address parsing/formatting, `buildTextAlternative(html)`, `newMessageIdHeader(domain)`, `stripQuotedReply(text)` |
| `server/mail/sanitize.ts` | DOMPurify HTML sanitizer, cid rewrite, remote image blocking |
| `server/mail/sync/engine.ts` | backfill/incremental → index rows + thread rollups + events |
| `server/mail/sync/scheduler.ts` | workers per account, timers, stop |
| `server/mail/sync/bodyCache.ts` | LRU of sanitized bodies |
| `server/mail/links.ts` | thread links CRUD + `resolveChain` |
| `server/mail/itemSendEffects.ts` | §4.6 |
| `server/mail/sendService.ts` | §4.5 |
| `server/mail/uploads.ts` | staged device uploads (`data/tmp/mail-uploads`) |
| `server/mail/routes.ts` | `registerMailRoutes` |
| `server/migrationList.ts` | migration 31 |
| `server/files.ts` | add `email-attachment` to `MULTI_INSTANCE_KINDS` |
| `server/routes.ts` | rewire 7 send routes; remove `sendProjectEmail`, SMTP routes |
| `server.ts` | wire crypto/scheduler/routes; remove `getUserSmtp`/`buildTransporter` |

Tests sit beside each file as `*.test.ts` (vitest `server` project picks up `server/**/*.test.ts`).

---

### Task 1: Crypto module

**Files:**
- Create: `server/mail/crypto.ts`
- Test: `server/mail/crypto.test.ts`

**Interfaces:**
- Produces: `class MailCrypto { seal(obj: unknown): string; open<T>(sealed: string): T }`, `loadMailCrypto(dataDir: string, env?: NodeJS.ProcessEnv): MailCrypto`.

- [ ] **Step 1: Write the failing test**

```ts
// server/mail/crypto.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MailCrypto, loadMailCrypto } from './crypto';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mc-'));

describe('MailCrypto', () => {
  it('round-trips an object and produces different ciphertext each time', () => {
    const c = new MailCrypto(Buffer.alloc(32, 7));
    const a = c.seal({ refreshToken: 'abc' });
    const b = c.seal({ refreshToken: 'abc' });
    expect(a).not.toEqual(b);                       // random IV
    expect(c.open(a)).toEqual({ refreshToken: 'abc' });
  });
  it('rejects tampered ciphertext', () => {
    const c = new MailCrypto(Buffer.alloc(32, 7));
    const s = c.seal({ x: 1 });
    const bad = s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA');
    expect(() => c.open(bad)).toThrow();
  });
  it('uses MAIL_SECRET_KEY when set (hex)', () => {
    const dir = tmp();
    const hex = Buffer.alloc(32, 1).toString('hex');
    const c = loadMailCrypto(dir, { MAIL_SECRET_KEY: hex } as any);
    expect(fs.existsSync(path.join(dir, 'mail.key'))).toBe(false);
    expect(c.open(c.seal({ ok: true }))).toEqual({ ok: true });
  });
  it('generates data/mail.key with mode 0600 when env is unset and reuses it', () => {
    const dir = tmp();
    const c1 = loadMailCrypto(dir, {} as any);
    const keyPath = path.join(dir, 'mail.key');
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    const sealed = c1.seal({ v: 2 });
    const c2 = loadMailCrypto(dir, {} as any);
    expect(c2.open(sealed)).toEqual({ v: 2 });
  });
  it('rejects a key of the wrong length', () => {
    expect(() => new MailCrypto(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project server server/mail/crypto.test.ts`
Expected: FAIL — cannot resolve `./crypto`.

- [ ] **Step 3: Implement**

```ts
// server/mail/crypto.ts
// AES-256-GCM sealing for mail secrets (spec §7). Key from MAIL_SECRET_KEY
// (hex or base64, 32 bytes) or an auto-generated data/mail.key (0600). The key
// deliberately lives OUTSIDE app.db so a copied database/backups can't read
// tokens; losing the key only forces users to reconnect accounts.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const IV_LEN = 12;
const TAG_LEN = 16;

export class MailCrypto {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('MailCrypto key must be 32 bytes');
  }
  seal(obj: unknown): string {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const plain = Buffer.from(JSON.stringify(obj), 'utf8');
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
  }
  open<T = unknown>(sealed: string): T {
    if (!sealed.startsWith('v1:')) throw new Error('Unknown sealed format');
    const buf = Buffer.from(sealed.slice(3), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  }
}

function parseKey(raw: string): Buffer {
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  const b = Buffer.from(t, 'base64');
  if (b.length === 32) return b;
  throw new Error('MAIL_SECRET_KEY must be 32 bytes as hex (64 chars) or base64');
}

export function loadMailCrypto(dataDir: string, env: NodeJS.ProcessEnv = process.env): MailCrypto {
  if (env.MAIL_SECRET_KEY) return new MailCrypto(parseKey(env.MAIL_SECRET_KEY));
  const keyPath = path.join(dataDir, 'mail.key');
  if (fs.existsSync(keyPath)) return new MailCrypto(parseKey(fs.readFileSync(keyPath, 'utf8')));
  fs.mkdirSync(dataDir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  console.log(`[mail] generated ${keyPath} — back it up with the data directory`);
  return new MailCrypto(key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project server server/mail/crypto.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add server/mail/crypto.ts server/mail/crypto.test.ts
git commit -m "feat(mail): AES-256-GCM secret sealing with env/key-file key"
```

---

### Task 2: Migration 31 — mail tables, rfis columns, SMTP transform

**Files:**
- Modify: `server/migrationList.ts` (append after version 30, ~line 1476)
- Modify: `server/files.ts:63-66` (`MULTI_INSTANCE_KINDS`)
- Test: `server/migrationList.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `MailCrypto` from Task 1 via `MigrationCtx` — extend `server/migrations.ts` `MigrationCtx` with optional `mailCrypto?: MailCrypto` and have `runMigrations` pass it through (see step 3b).
- Produces: tables `mail_accounts`, `mail_folders`, `mail_messages`, `mail_threads`, `mail_thread_links`, `mail_thread_reply_state`; columns `rfis.pendingReplyJson`, `rfis.responseSource`, `rfis.responseMessageIdHeader`.

- [ ] **Step 1: Write the failing test**

Append to `server/migrationList.test.ts`:

```ts
import { loadMailCrypto } from './mail/crypto';

describe('migration 31 mail-client', () => {
  const setup = () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 30));
    return { db, dir };
  };
  it('creates the mail tables and rfis columns', () => {
    const { db, dir } = setup();
    runMigrations(db, dir, migrations, { mailCrypto: loadMailCrypto(dir, {} as any) });
    const tables = tableNames(db);
    for (const t of ['mail_accounts', 'mail_folders', 'mail_messages', 'mail_threads', 'mail_thread_links', 'mail_thread_reply_state']) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    for (const c of ['pendingReplyJson', 'responseSource', 'responseMessageIdHeader']) {
      expect(columnNames(db, 'rfis')).toContain(c);
    }
    db.close();
  });
  it('migrates smtp.* prefs into a sealed imap account and deletes the prefs', () => {
    const { db, dir } = setup();
    db.prepare(`INSERT INTO users (id, username, password, role, createdAt) VALUES ('u9','nate','x','admin',1)`).run();
    const ins = db.prepare('INSERT INTO user_preferences (userId, key, value) VALUES (?, ?, ?)');
    for (const [k, v] of Object.entries({ 'smtp.host': 'smtp.example.com', 'smtp.port': '465', 'smtp.secure': 'true',
      'smtp.username': 'nate@example.com', 'smtp.password': 'hunter2', 'smtp.fromName': 'Nate', 'smtp.fromAddress': 'nate@example.com', 'theme': 'dark' })) ins.run('u9', k, v);
    const crypto = loadMailCrypto(dir, {} as any);
    runMigrations(db, dir, migrations, { mailCrypto: crypto });
    const acct = db.prepare('SELECT * FROM mail_accounts WHERE userId = ?').get('u9') as any;
    expect(acct.provider).toBe('imap');
    expect(acct.emailAddress).toBe('nate@example.com');
    expect(acct.displayName).toBe('Nate');
    expect(acct.status).toBe('needs_review');
    expect(acct.isDefault).toBe(1);
    expect(acct.authBlob).not.toContain('hunter2');
    expect(crypto.open<any>(acct.authBlob)).toMatchObject({ smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true, imapHost: 'smtp.example.com', imapPort: 993, imapSecure: true, username: 'nate@example.com', password: 'hunter2' });
    const left = db.prepare("SELECT key FROM user_preferences WHERE userId='u9'").all().map((r: any) => r.key);
    expect(left).toEqual(['theme']);
    db.close();
  });
  it('skips the transform (keeps prefs) when no crypto is supplied', () => {
    const { db, dir } = setup();
    db.prepare(`INSERT INTO users (id, username, password, role, createdAt) VALUES ('u9','nate','x','admin',1)`).run();
    db.prepare('INSERT INTO user_preferences (userId, key, value) VALUES (?,?,?)').run('u9', 'smtp.host', 'h');
    runMigrations(db, dir, migrations);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_accounts').get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM user_preferences WHERE key LIKE 'smtp.%'").get()).toEqual({ c: 1 });
    db.close();
  });
});
```

Check the `users` insert columns against migration 1 in `server/migrationList.ts:26` before running (adjust the column list if `users` has NOT NULL columns beyond these).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project server server/migrationList.test.ts -t "migration 31"`
Expected: FAIL — tables missing / `runMigrations` 4th arg unused.

- [ ] **Step 3a: Extend `MigrationCtx`**

In `server/migrations.ts`, `MigrationCtx` (line 5) gains `mailCrypto?: import('./mail/crypto').MailCrypto;`. `runMigrations` ALREADY takes a 4th options object (`{ dbFile, vacuum }` — see `server.ts:72`); add `mailCrypto?: MailCrypto` to that options type and pass it through into the ctx handed to each `up()`. All existing callers keep working.

- [ ] **Step 3b: Append migration 31**

```ts
  {
    version: 31,
    name: 'mail-client',
    // ADDITIVE tables (spec 2026-08-29 mail client §3) + rfis columns, PLUS a
    // TRANSFORM: per-user smtp.* prefs become a sealed `imap` mail account in
    // status needs_review and the prefs are deleted. The transform runs only
    // when ctx.mailCrypto is supplied (server startup always supplies it;
    // bare test harnesses may not) so it is safe to re-run.
    up({ db, mailCrypto }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mail_accounts (
          id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL,
          emailAddress TEXT NOT NULL, displayName TEXT, signatureHtml TEXT,
          isDefault INTEGER NOT NULL DEFAULT 0, authBlob TEXT NOT NULL,
          syncState TEXT, indexedSince TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok',
          lastSyncAt TEXT, lastError TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS idx_mail_accounts_user ON mail_accounts(userId);
        CREATE TABLE IF NOT EXISTS mail_folders (
          id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, name TEXT NOT NULL,
          role TEXT, unreadCount INTEGER NOT NULL DEFAULT 0, totalCount INTEGER NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (accountId) REFERENCES mail_accounts(id) ON DELETE CASCADE);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_folders_acct_pid ON mail_folders(accountId, providerId);
        CREATE TABLE IF NOT EXISTS mail_messages (
          id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerMessageId TEXT NOT NULL, providerThreadId TEXT,
          messageIdHeader TEXT, inReplyTo TEXT, referencesJson TEXT NOT NULL DEFAULT '[]', threadKey TEXT NOT NULL,
          fromAddr TEXT, fromName TEXT, toJson TEXT NOT NULL DEFAULT '[]', ccJson TEXT NOT NULL DEFAULT '[]', bccJson TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', date TEXT NOT NULL,
          isRead INTEGER NOT NULL DEFAULT 0, isStarred INTEGER NOT NULL DEFAULT 0, isDraft INTEGER NOT NULL DEFAULT 0,
          hasAttachments INTEGER NOT NULL DEFAULT 0, attachmentsJson TEXT NOT NULL DEFAULT '[]', sizeBytes INTEGER NOT NULL DEFAULT 0,
          folderIdsJson TEXT NOT NULL DEFAULT '[]', sentFromApp INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          FOREIGN KEY (accountId) REFERENCES mail_accounts(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_acct_date ON mail_messages(accountId, date DESC);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_acct_thread ON mail_messages(accountId, threadKey);
        CREATE INDEX IF NOT EXISTS idx_mail_messages_mid ON mail_messages(messageIdHeader);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_acct_pmid ON mail_messages(accountId, providerMessageId);
        CREATE TABLE IF NOT EXISTS mail_threads (
          id TEXT PRIMARY KEY, accountId TEXT NOT NULL, threadKey TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
          firstDate TEXT NOT NULL, lastDate TEXT NOT NULL, messageCount INTEGER NOT NULL DEFAULT 0, unreadCount INTEGER NOT NULL DEFAULT 0,
          hasAttachments INTEGER NOT NULL DEFAULT 0, isStarred INTEGER NOT NULL DEFAULT 0,
          participantsJson TEXT NOT NULL DEFAULT '[]', folderIdsJson TEXT NOT NULL DEFAULT '[]', updatedAt TEXT NOT NULL,
          FOREIGN KEY (accountId) REFERENCES mail_accounts(id) ON DELETE CASCADE);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_threads_acct_key ON mail_threads(accountId, threadKey);
        CREATE INDEX IF NOT EXISTS idx_mail_threads_acct_last ON mail_threads(accountId, lastDate DESC);
        CREATE TABLE IF NOT EXISTS mail_thread_links (
          id TEXT PRIMARY KEY, threadKey TEXT NOT NULL, subjectSnapshot TEXT, firstDate TEXT, participantsJson TEXT NOT NULL DEFAULT '[]',
          itemType TEXT NOT NULL, itemId TEXT NOT NULL, projectId TEXT, customerId TEXT, linkedByUserId TEXT NOT NULL, createdAt TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_links_unique ON mail_thread_links(threadKey, itemType, itemId);
        CREATE INDEX IF NOT EXISTS idx_mail_links_item ON mail_thread_links(itemType, itemId);
        CREATE INDEX IF NOT EXISTS idx_mail_links_project ON mail_thread_links(projectId);
        CREATE INDEX IF NOT EXISTS idx_mail_links_customer ON mail_thread_links(customerId);
        CREATE INDEX IF NOT EXISTS idx_mail_links_thread ON mail_thread_links(threadKey);
        CREATE TABLE IF NOT EXISTS mail_thread_reply_state (
          threadKey TEXT PRIMARY KEY, lastInboundDate TEXT, lastOutboundDate TEXT, updatedAt TEXT NOT NULL);
      `);
      const hasCol = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).some(x => x.name === c);
      if (!hasCol('rfis', 'pendingReplyJson')) db.exec('ALTER TABLE rfis ADD COLUMN pendingReplyJson TEXT');
      if (!hasCol('rfis', 'responseSource')) db.exec('ALTER TABLE rfis ADD COLUMN responseSource TEXT');
      if (!hasCol('rfis', 'responseMessageIdHeader')) db.exec('ALTER TABLE rfis ADD COLUMN responseMessageIdHeader TEXT');

      if (!mailCrypto) { console.warn('[migration 31] mailCrypto not supplied — smtp.* transform skipped'); return; }
      const users = db.prepare("SELECT DISTINCT userId FROM user_preferences WHERE key = 'smtp.host' AND TRIM(value) <> ''").all() as { userId: string }[];
      const now = new Date().toISOString();
      const since = new Date(Date.now() - 180 * 86400000).toISOString();
      for (const { userId } of users) {
        const rows = db.prepare("SELECT key, value FROM user_preferences WHERE userId = ? AND key LIKE 'smtp.%'").all(userId) as { key: string; value: string }[];
        const cfg: Record<string, string> = {};
        rows.forEach(r => { cfg[r.key.slice(5)] = r.value; });
        const smtpPort = parseInt(cfg.port || '587', 10) || 587;
        const auth = {
          imapHost: cfg.host, imapPort: 993, imapSecure: true,
          smtpHost: cfg.host, smtpPort, smtpSecure: cfg.secure === 'true',
          username: cfg.username || '', password: cfg.password || '',
        };
        const email = (cfg.fromAddress || cfg.username || '').trim();
        if (!email) continue;
        const id = 'mailacct-' + userId;
        db.prepare(`INSERT OR IGNORE INTO mail_accounts (id, userId, provider, emailAddress, displayName, isDefault, authBlob, indexedSince, status, createdAt, updatedAt)
                    VALUES (?, ?, 'imap', ?, ?, 1, ?, ?, 'needs_review', ?, ?)`)
          .run(id, userId, email, cfg.fromName || null, mailCrypto.seal(auth), since, now, now);
        db.prepare("DELETE FROM user_preferences WHERE userId = ? AND key LIKE 'smtp.%'").run(userId);
      }
    },
  },
```

- [ ] **Step 3c: `MULTI_INSTANCE_KINDS`**

In `server/files.ts:63`, add `'email-attachment'` to the array (comment: several attachments saved from one message share a source triple — spec §3.2).

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project server server/migrationList.test.ts server/migrations.test.ts server/files.test.ts`
Expected: all pass (new 3 + existing).

- [ ] **Step 5: Commit**

```bash
git add server/migrations.ts server/migrationList.ts server/migrationList.test.ts server/files.ts
git commit -m "feat(mail): migration 31 — mail tables, rfis reply columns, smtp→account transform"
```

---
### Task 3: Account store

**Files:**
- Create: `server/mail/context.ts`, `server/mail/accountStore.ts`
- Test: `server/mail/accountStore.test.ts`

**Interfaces:**
- Consumes: `MailCrypto` (Task 1), migration 31 (Task 2).
- Produces: the `accountStore` surface from the shared contract; `MailAccountRow` has **no** `authBlob`.

- [ ] **Step 1: Write the failing test**

```ts
// server/mail/accountStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { MailCrypto } from './crypto';
import * as store from './accountStore';

let db: Database.Database; const crypto = new MailCrypto(Buffer.alloc(32, 3));
const imapAuth: store.ImapAuth = { imapHost: 'imap.x', imapPort: 993, imapSecure: true, smtpHost: 'smtp.x', smtpPort: 587, smtpSecure: false, username: 'u', password: 'p' };

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-as-')), migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role, createdAt) VALUES ('u1','a','x','admin',1), ('u2','b','x','user',1)`).run();
});

describe('accountStore', () => {
  it('creates a sealed account, first one becomes default, rows never expose authBlob', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    expect(a.isDefault).toBe(1);
    expect((a as any).authBlob).toBeUndefined();
    const raw = db.prepare('SELECT authBlob FROM mail_accounts WHERE id = ?').get(a.id) as any;
    expect(raw.authBlob).not.toContain('"p"');
    expect(store.readAuth(db, crypto, a.id)).toEqual(imapAuth);
    expect(a.indexedSince <= new Date().toISOString()).toBe(true);
  });
  it('second account is not default; setDefault flips exactly one', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    const b = store.createAccount(db, crypto, { userId: 'u1', provider: 'google', emailAddress: 'b@x', auth: { refreshToken: 'r' } });
    expect(b.isDefault).toBe(0);
    store.setDefault(db, 'u1', b.id);
    expect(store.getOwned(db, 'u1', a.id)!.isDefault).toBe(0);
    expect(store.getOwned(db, 'u1', b.id)!.isDefault).toBe(1);
  });
  it('getOwned enforces ownership; listAccounts scoped per user', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    expect(store.getOwned(db, 'u2', a.id)).toBeNull();
    expect(store.listAccounts(db, 'u2')).toEqual([]);
    expect(store.listAccounts(db, 'u1').map(r => r.id)).toEqual([a.id]);
  });
  it('updateAccount patches status/syncState; listActiveAccounts filters', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    store.updateAccount(db, a.id, { status: 'auth_error', lastError: 'bad token', syncState: JSON.stringify({ historyId: '5' }) });
    const row = store.getAccountAny(db, a.id)!;
    expect(row.status).toBe('auth_error'); expect(row.lastError).toBe('bad token'); expect(JSON.parse(row.syncState!)).toEqual({ historyId: '5' });
    expect(store.listActiveAccounts(db)).toEqual([]);
    store.updateAccount(db, a.id, { status: 'ok' });
    expect(store.listActiveAccounts(db).map(r => r.id)).toEqual([a.id]);
  });
  it('deleteAccount removes it and promotes another to default', () => {
    const a = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'a@x', auth: imapAuth });
    const b = store.createAccount(db, crypto, { userId: 'u1', provider: 'imap', emailAddress: 'b@x', auth: imapAuth });
    store.deleteAccount(db, a.id);
    expect(store.getAccountAny(db, a.id)).toBeNull();
    expect(store.getOwned(db, 'u1', b.id)!.isDefault).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project server server/mail/accountStore.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// server/mail/context.ts
import type Database from 'better-sqlite3';
import type { BroadcastChange } from '../realtime/changeFeed';
import type { MailCrypto } from './crypto';
import type { MailProvider } from './providers/types';
import type { MailAccountRow, ImapAuth, OAuthAuth } from './accountStore';
import type { MailScheduler } from './sync/scheduler';

export interface MailContext {
  db: Database.Database;
  dataDir: string;
  crypto: MailCrypto;
  providerFactory: (account: MailAccountRow, auth: ImapAuth | OAuthAuth) => MailProvider;
  broadcastChange: BroadcastChange;
  scheduler?: MailScheduler;
}
```

```ts
// server/mail/accountStore.ts
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { MailCrypto } from './crypto';

export type MailAccountStatus = 'ok' | 'syncing' | 'auth_error' | 'needs_review' | 'disabled';
export interface MailAccountRow {
  id: string; userId: string; provider: 'google' | 'microsoft' | 'imap' | 'fake'; emailAddress: string;
  displayName: string | null; signatureHtml: string | null; isDefault: number; syncState: string | null;
  indexedSince: string; status: MailAccountStatus; lastSyncAt: string | null; lastError: string | null;
  createdAt: string; updatedAt: string;
}
export type ImapAuth = { imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean; username: string; password: string };
export type OAuthAuth = { refreshToken: string };

const COLS = 'id, userId, provider, emailAddress, displayName, signatureHtml, isDefault, syncState, indexedSince, status, lastSyncAt, lastError, createdAt, updatedAt';

export function listAccounts(db: Database.Database, userId: string): MailAccountRow[] {
  return db.prepare(`SELECT ${COLS} FROM mail_accounts WHERE userId = ? ORDER BY isDefault DESC, createdAt`).all(userId) as MailAccountRow[];
}
export function getOwned(db: Database.Database, userId: string, accountId: string): MailAccountRow | null {
  return (db.prepare(`SELECT ${COLS} FROM mail_accounts WHERE id = ? AND userId = ?`).get(accountId, userId) as MailAccountRow) ?? null;
}
export function getAccountAny(db: Database.Database, accountId: string): MailAccountRow | null {
  return (db.prepare(`SELECT ${COLS} FROM mail_accounts WHERE id = ?`).get(accountId) as MailAccountRow) ?? null;
}
export function listActiveAccounts(db: Database.Database): MailAccountRow[] {
  return db.prepare(`SELECT ${COLS} FROM mail_accounts WHERE status IN ('ok','syncing')`).all() as MailAccountRow[];
}
export function createAccount(db: Database.Database, crypto: MailCrypto, input: {
  userId: string; provider: MailAccountRow['provider']; emailAddress: string; displayName?: string | null;
  auth: ImapAuth | OAuthAuth; status?: MailAccountStatus; indexedSince?: string;
}): MailAccountRow {
  const id = uuidv4();
  const now = new Date().toISOString();
  const since = input.indexedSince ?? new Date(Date.now() - 180 * 86400000).toISOString();
  const hasDefault = db.prepare('SELECT 1 FROM mail_accounts WHERE userId = ? AND isDefault = 1').get(input.userId);
  db.prepare(`INSERT INTO mail_accounts (id, userId, provider, emailAddress, displayName, isDefault, authBlob, indexedSince, status, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.userId, input.provider, input.emailAddress.trim().toLowerCase(), input.displayName ?? null, hasDefault ? 0 : 1,
         crypto.seal(input.auth), since, input.status ?? 'ok', now, now);
  return getAccountAny(db, id)!;
}
export function updateAccount(db: Database.Database, accountId: string,
  patch: Partial<Pick<MailAccountRow, 'displayName' | 'signatureHtml' | 'status' | 'lastSyncAt' | 'lastError' | 'syncState' | 'indexedSince' | 'emailAddress'>>): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE mail_accounts SET ${sets}, updatedAt = ? WHERE id = ?`).run(...keys.map(k => patch[k] ?? null), new Date().toISOString(), accountId);
}
export function updateAuth(db: Database.Database, crypto: MailCrypto, accountId: string, auth: ImapAuth | OAuthAuth): void {
  db.prepare('UPDATE mail_accounts SET authBlob = ?, updatedAt = ? WHERE id = ?').run(crypto.seal(auth), new Date().toISOString(), accountId);
}
export function readAuth(db: Database.Database, crypto: MailCrypto, accountId: string): ImapAuth | OAuthAuth | null {
  const row = db.prepare('SELECT authBlob FROM mail_accounts WHERE id = ?').get(accountId) as { authBlob: string } | undefined;
  return row ? crypto.open<ImapAuth | OAuthAuth>(row.authBlob) : null;
}
export function setDefault(db: Database.Database, userId: string, accountId: string): void {
  db.transaction(() => {
    db.prepare('UPDATE mail_accounts SET isDefault = 0 WHERE userId = ?').run(userId);
    db.prepare('UPDATE mail_accounts SET isDefault = 1 WHERE id = ? AND userId = ?').run(accountId, userId);
  })();
}
export function deleteAccount(db: Database.Database, accountId: string): void {
  db.transaction(() => {
    const row = getAccountAny(db, accountId);
    if (!row) return;
    db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(accountId); // cascades folders/messages/threads
    if (row.isDefault) {
      const next = db.prepare('SELECT id FROM mail_accounts WHERE userId = ? ORDER BY createdAt LIMIT 1').get(row.userId) as { id: string } | undefined;
      if (next) db.prepare('UPDATE mail_accounts SET isDefault = 1 WHERE id = ?').run(next.id);
    }
  })();
}
```

- [ ] **Step 4: Run tests** → `npx vitest run --project server server/mail/accountStore.test.ts` → 5 passed.

- [ ] **Step 5: Commit**

```bash
git add server/mail/context.ts server/mail/accountStore.ts server/mail/accountStore.test.ts
git commit -m "feat(mail): account store with sealed credentials"
```

---

### Task 4: Thread-key engine

**Files:**
- Create: `server/mail/threadKey.ts`
- Test: `server/mail/threadKey.test.ts`

**Interfaces:**
- Produces:
  - `normalizeMessageId(raw: string | null | undefined): string | null` — strips `<>`/whitespace, lowercases.
  - `deriveThreadKey(lookup: (messageIdHeader: string) => string | null, env: { messageIdHeader: string | null; inReplyTo: string | null; references: string[]; fallbackSeed: string }): { threadKey: string; synthetic: boolean }`
  - `mergeThreadKeys(db, accountId, fromKey, toKey): void` — rewrites `mail_messages`, `mail_threads` (drops the `fromKey` rollup; caller rebuilds), `mail_thread_links`, `mail_thread_reply_state`.
  - `normalizeSubject(s: string): string` — strips leading `re:`/`fw:`/`fwd:` (repeated, case-insensitive), trims, lowercases.

- [ ] **Step 1: Write the failing test**

```ts
// server/mail/threadKey.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeMessageId, deriveThreadKey, normalizeSubject, mergeThreadKeys } from './threadKey';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import fs from 'fs'; import os from 'os'; import path from 'path';

describe('normalizeMessageId', () => {
  it('strips brackets and whitespace, lowercases', () => {
    expect(normalizeMessageId(' <ABC@Mail.Example> ')).toBe('abc@mail.example');
    expect(normalizeMessageId('')).toBeNull(); expect(normalizeMessageId(undefined)).toBeNull();
  });
});
describe('normalizeSubject', () => {
  it('removes reply/forward prefixes repeatedly', () => {
    expect(normalizeSubject('RE: Fwd: re: Change Order #4')).toBe('change order #4');
    expect(normalizeSubject('  FW:  Quote ')).toBe('quote');
  });
});
describe('deriveThreadKey', () => {
  const none = () => null;
  it('own Message-ID becomes the key for a root message', () => {
    expect(deriveThreadKey(none, { messageIdHeader: 'root@x', inReplyTo: null, references: [], fallbackSeed: 'a' })).toEqual({ threadKey: 'root@x', synthetic: false });
  });
  it('reuses an existing key found via References (earliest first)', () => {
    const lookup = (id: string) => (id === 'mid@x' ? 'existing-key' : null);
    expect(deriveThreadKey(lookup, { messageIdHeader: 'new@x', inReplyTo: 'mid@x', references: ['root@x', 'mid@x'], fallbackSeed: 'a' }).threadKey).toBe('existing-key');
  });
  it('falls back to the References root when nothing is indexed yet', () => {
    expect(deriveThreadKey(none, { messageIdHeader: 'new@x', inReplyTo: 'mid@x', references: ['root@x', 'mid@x'], fallbackSeed: 'a' }).threadKey).toBe('root@x');
  });
  it('uses In-Reply-To when References is empty', () => {
    expect(deriveThreadKey(none, { messageIdHeader: 'new@x', inReplyTo: 'parent@x', references: [], fallbackSeed: 'a' }).threadKey).toBe('parent@x');
  });
  it('synthesizes a key when there is no Message-ID', () => {
    const r = deriveThreadKey(none, { messageIdHeader: null, inReplyTo: null, references: [], fallbackSeed: 'acct:pm1' });
    expect(r.synthetic).toBe(true); expect(r.threadKey.startsWith('synthetic:')).toBe(true);
    expect(deriveThreadKey(none, { messageIdHeader: null, inReplyTo: null, references: [], fallbackSeed: 'acct:pm1' }).threadKey).toBe(r.threadKey);
  });
});
describe('mergeThreadKeys', () => {
  it('rewrites messages, links, reply state and drops the stale thread rollup', () => {
    const db = openDb(':memory:');
    runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-tk-')), migrations);
    db.prepare(`INSERT INTO users (id, username, password, role, createdAt) VALUES ('u1','a','x','admin',1)`).run();
    db.prepare(`INSERT INTO mail_accounts (id,userId,provider,emailAddress,isDefault,authBlob,indexedSince,status,createdAt,updatedAt) VALUES ('a1','u1','fake','a@x',1,'v1:x','2026-01-01','ok','t','t')`).run();
    const ins = db.prepare(`INSERT INTO mail_messages (id,accountId,providerMessageId,threadKey,date,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`);
    ins.run('m1', 'a1', 'p1', 'child@x', '2026-01-02', 't', 't'); ins.run('m2', 'a1', 'p2', 'root@x', '2026-01-01', 't', 't');
    db.prepare(`INSERT INTO mail_threads (id,accountId,threadKey,firstDate,lastDate,updatedAt) VALUES ('t1','a1','child@x','2026-01-02','2026-01-02','t'),('t2','a1','root@x','2026-01-01','2026-01-01','t')`).run();
    db.prepare(`INSERT INTO mail_thread_links (id,threadKey,itemType,itemId,linkedByUserId,createdAt) VALUES ('l1','child@x','rfi','r1','u1','t')`).run();
    db.prepare(`INSERT INTO mail_thread_reply_state (threadKey,updatedAt) VALUES ('child@x','t')`).run();
    mergeThreadKeys(db, 'a1', 'child@x', 'root@x');
    expect(db.prepare(`SELECT threadKey FROM mail_messages WHERE id='m1'`).get()).toEqual({ threadKey: 'root@x' });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_threads WHERE threadKey='child@x'`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT threadKey FROM mail_thread_links WHERE id='l1'`).get()).toEqual({ threadKey: 'root@x' });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_thread_reply_state WHERE threadKey='root@x'`).get()).toEqual({ c: 1 });
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// server/mail/threadKey.ts  (spec §3.1)
import crypto from 'crypto';
import type Database from 'better-sqlite3';

export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().replace(/^<+|>+$/g, '').trim().toLowerCase();
  return t || null;
}
export function normalizeSubject(s: string): string {
  let t = (s || '').trim();
  const re = /^(re|fw|fwd|aw|wg)\s*:\s*/i;
  while (re.test(t)) t = t.replace(re, '').trim();
  return t.replace(/\s+/g, ' ').toLowerCase();
}
export function deriveThreadKey(
  lookup: (messageIdHeader: string) => string | null,
  env: { messageIdHeader: string | null; inReplyTo: string | null; references: string[]; fallbackSeed: string },
): { threadKey: string; synthetic: boolean } {
  const refs = env.references.map(normalizeMessageId).filter((x): x is string => !!x);
  const irt = normalizeMessageId(env.inReplyTo);
  const own = normalizeMessageId(env.messageIdHeader);
  const candidates = [...refs, ...(irt ? [irt] : []), ...(own ? [own] : [])];
  for (const c of candidates) { const k = lookup(c); if (k) return { threadKey: k, synthetic: false }; }
  if (refs.length) return { threadKey: refs[0], synthetic: false };
  if (irt) return { threadKey: irt, synthetic: false };
  if (own) return { threadKey: own, synthetic: false };
  return { threadKey: 'synthetic:' + crypto.createHash('sha1').update(env.fallbackSeed).digest('hex'), synthetic: true };
}
// A late-arriving root bridges two keys: fold `fromKey` into `toKey`. The
// mail_threads rollup for fromKey is dropped — the engine rebuilds toKey's.
export function mergeThreadKeys(db: Database.Database, accountId: string, fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  db.transaction(() => {
    db.prepare('UPDATE mail_messages SET threadKey = ? WHERE accountId = ? AND threadKey = ?').run(toKey, accountId, fromKey);
    db.prepare('DELETE FROM mail_threads WHERE accountId = ? AND threadKey = ?').run(accountId, fromKey);
    db.prepare('UPDATE OR IGNORE mail_thread_links SET threadKey = ? WHERE threadKey = ?').run(toKey, fromKey);
    db.prepare('DELETE FROM mail_thread_links WHERE threadKey = ?').run(fromKey); // leftovers that collided on the unique index
    db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)').run(toKey, new Date().toISOString());
    db.prepare(`UPDATE mail_thread_reply_state SET
        lastInboundDate = MAX(COALESCE(lastInboundDate,''), COALESCE((SELECT lastInboundDate FROM mail_thread_reply_state WHERE threadKey = ?),'')),
        lastOutboundDate = MAX(COALESCE(lastOutboundDate,''), COALESCE((SELECT lastOutboundDate FROM mail_thread_reply_state WHERE threadKey = ?),''))
      WHERE threadKey = ?`).run(fromKey, fromKey, toKey);
    db.prepare('DELETE FROM mail_thread_reply_state WHERE threadKey = ?').run(fromKey);
  })();
}
```

- [ ] **Step 4: Run** → `npx vitest run --project server server/mail/threadKey.test.ts` → all pass.

- [ ] **Step 5: Commit**

```bash
git add server/mail/threadKey.ts server/mail/threadKey.test.ts
git commit -m "feat(mail): thread-key derivation and merge"
```

---

### Task 5: Provider contract, MIME helpers, fake provider

**Files:**
- Create: `server/mail/providers/types.ts` (exactly the shared contract above), `server/mail/mime.ts`, `server/mail/providers/fake.ts`
- Test: `server/mail/mime.test.ts`, `server/mail/providers/fake.test.ts`

**Interfaces:**
- Produces (`mime.ts`): `parseAddress(s: string): Addr | null`, `parseAddressList(s: string): Addr[]`, `formatAddress(a: Addr): string`, `htmlToText(html: string): string`, `newMessageIdHeader(domain: string): string` (`<uuid@domain>` normalized form returned WITHOUT brackets), `stripQuotedReply(text: string): string`, `snippetOf(text: string): string` (≤200 chars, whitespace-collapsed).
- Produces (`fake.ts`): `class FakeMailProvider implements MailProvider` with test helpers `seed(envelopes: Array<Envelope & { html?: string; text?: string; attachmentBytes?: Record<string, Buffer> }>)`, `injectInbound(partial)`, `sent: OutgoingMessage[]`, `drafts: Map`, `flags: Map`, `failNextWith(err: Error)`. `incremental` returns everything injected since the `state.cursor` counter.
- `providers/fakeRegistry.ts`: `getFakeProvider(accountId): FakeMailProvider` (one instance per account id, module-level map, `resetFakes()`), so routes/tests/E2E share instances when `MAIL_FAKE_PROVIDER=1`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/mail/mime.test.ts
import { describe, it, expect } from 'vitest';
import { parseAddressList, formatAddress, htmlToText, stripQuotedReply, snippetOf, newMessageIdHeader } from './mime';

describe('mime helpers', () => {
  it('parses display-name and bare addresses', () => {
    expect(parseAddressList('"Mike T" <m@x.com>, a@y.org; bad')).toEqual([{ addr: 'm@x.com', name: 'Mike T' }, { addr: 'a@y.org' }]);
  });
  it('formats with quotes only when a name exists', () => {
    expect(formatAddress({ addr: 'm@x.com', name: 'Mike' })).toBe('"Mike" <m@x.com>');
    expect(formatAddress({ addr: 'm@x.com' })).toBe('m@x.com');
  });
  it('htmlToText keeps line breaks for block elements and drops tags', () => {
    expect(htmlToText('<p>Hi<br>there</p><div>ok &amp; done</div>')).toBe('Hi\nthere\nok & done');
  });
  it('stripQuotedReply removes On … wrote:, > blocks and From: headers', () => {
    const t = 'Approved.\n\nOn Aug 25, 2026, Nathan wrote:\n> COR attached\n> thanks';
    expect(stripQuotedReply(t)).toBe('Approved.');
    expect(stripQuotedReply('Yes\n\nFrom: Nathan\nSent: x\n\noriginal')).toBe('Yes');
    expect(stripQuotedReply('> only quoted')).toBe('> only quoted');   // never returns empty
  });
  it('snippetOf collapses whitespace and caps at 200', () => {
    expect(snippetOf('a\n\n  b'.padEnd(500, 'x')).length).toBe(200);
  });
  it('newMessageIdHeader is bracket-free and lowercase', () => {
    expect(newMessageIdHeader('Bigbear.com')).toMatch(/^[0-9a-f-]{36}@bigbear\.com$/);
  });
});
```

```ts
// server/mail/providers/fake.test.ts
import { describe, it, expect } from 'vitest';
import { FakeMailProvider } from './fake';

const env = (id: string, extra: Partial<Parameters<FakeMailProvider['seed']>[0][number]> = {}) => ({
  providerMessageId: id, references: [], from: { addr: 'x@y' }, to: [], cc: [], bcc: [], subject: 's', snippet: '', date: '2026-08-01T00:00:00.000Z',
  isRead: false, isStarred: false, isDraft: false, attachments: [], sizeBytes: 1, folderProviderIds: ['INBOX'], ...extra,
});

describe('FakeMailProvider', () => {
  it('backfills seeded messages after `since` and reports done', async () => {
    const p = new FakeMailProvider();
    p.seed([env('a', { date: '2026-01-01T00:00:00.000Z' }), env('b', { date: '2026-08-01T00:00:00.000Z' })]);
    const r = await p.backfill({ since: new Date('2026-06-01') });
    expect(r.messages.map(m => m.providerMessageId)).toEqual(['b']); expect(r.done).toBe(true);
  });
  it('incremental returns injected messages once', async () => {
    const p = new FakeMailProvider(); p.seed([]);
    let s = (await p.incremental({})).state;
    p.injectInbound(env('n1'));
    const r = await p.incremental(s); expect(r.upserts.map(m => m.providerMessageId)).toEqual(['n1']); s = r.state;
    expect((await p.incremental(s)).upserts).toEqual([]);
  });
  it('send records the message and makes it fetchable', async () => {
    const p = new FakeMailProvider(); p.seed([]);
    const r = await p.send({ from: { addr: 'me@x' }, to: [{ addr: 'y@z' }], cc: [], bcc: [], subject: 'hi', html: '<b>hi</b>', text: 'hi', attachments: [], messageIdHeader: 'mid@x' });
    expect(p.sent.length).toBe(1);
    expect((await p.getBody(r.providerMessageId)).html).toBe('<b>hi</b>');
  });
  it('failNextWith throws once', async () => {
    const p = new FakeMailProvider(); p.seed([]);
    p.failNextWith(new Error('boom'));
    await expect(p.listFolders()).rejects.toThrow('boom');
    await expect(p.listFolders()).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run** → both FAIL (modules missing).

- [ ] **Step 3: Implement `types.ts`** exactly as in the shared contract (plus `export type FolderRole` etc.).

- [ ] **Step 3b: Implement `mime.ts`**

```ts
// server/mail/mime.ts
import { v4 as uuidv4 } from 'uuid';
import type { Addr } from './providers/types';

const ADDR_RE = /^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$|^\s*([^\s<>@]+@[^\s<>]+)\s*$/;
export function parseAddress(s: string): Addr | null {
  const m = ADDR_RE.exec(s || '');
  if (!m) return null;
  if (m[2]) { const name = (m[1] || '').trim(); return name ? { addr: m[2].trim().toLowerCase(), name } : { addr: m[2].trim().toLowerCase() }; }
  return { addr: m[3].trim().toLowerCase() };
}
export function parseAddressList(s: string): Addr[] {
  return (s || '').split(/[,;]/).map(parseAddress).filter((a): a is Addr => !!a);
}
export function formatAddress(a: Addr): string {
  return a.name ? `"${a.name.replace(/"/g, '')}" <${a.addr}>` : a.addr;
}
export function htmlToText(html: string): string {
  return (html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function newMessageIdHeader(domain: string): string {
  return `${uuidv4()}@${(domain || 'localhost').toLowerCase()}`;
}
// Keeps only the author's own words: cuts at "On … wrote:", an Outlook
// "From:" header block, or the first run of '>'-quoted lines. Never returns
// an empty string — a reply that is ALL quote comes back untouched.
export function stripQuotedReply(text: string): string {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^on .+wrote:$/i.test(l) || /^-{2,}\s*original message\s*-{2,}$/i.test(l) || /^from:\s.+/i.test(l) || l.startsWith('>')) { cut = i; break; }
  }
  const out = lines.slice(0, cut).join('\n').trim();
  return out || (text || '').trim();
}
export function snippetOf(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
```

- [ ] **Step 3c: Implement `fake.ts` + `fakeRegistry.ts`**

```ts
// server/mail/providers/fake.ts
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import type { MailProvider, Envelope, ProviderFolder, SyncState, OutgoingMessage, AttachmentMeta } from './types';
import { ProviderNotFoundError } from './types';

type Seeded = Envelope & { html?: string; text?: string; attachmentBytes?: Record<string, Buffer> };

export class FakeMailProvider implements MailProvider {
  kind = 'fake' as const;
  private msgs = new Map<string, Seeded>();
  private log: Array<{ seq: number; upsert?: string; delete?: string }> = [];
  private seq = 0;
  sent: OutgoingMessage[] = [];
  drafts = new Map<string, OutgoingMessage>();
  folders: ProviderFolder[] = [
    { providerId: 'INBOX', name: 'Inbox', role: 'inbox' }, { providerId: 'SENT', name: 'Sent', role: 'sent' },
    { providerId: 'DRAFTS', name: 'Drafts', role: 'drafts' }, { providerId: 'TRASH', name: 'Trash', role: 'trash' },
    { providerId: 'ARCHIVE', name: 'Archive', role: 'archive' },
  ];
  private nextFailure: Error | null = null;

  seed(list: Seeded[]): void { this.msgs.clear(); this.log = []; list.forEach(m => this.msgs.set(m.providerMessageId, m)); }
  injectInbound(m: Seeded): void { this.msgs.set(m.providerMessageId, m); this.log.push({ seq: ++this.seq, upsert: m.providerMessageId }); }
  failNextWith(err: Error): void { this.nextFailure = err; }
  private guard(): void { if (this.nextFailure) { const e = this.nextFailure; this.nextFailure = null; throw e; } }

  async listFolders(): Promise<ProviderFolder[]> { this.guard(); return this.folders; }
  async backfill(opts: { since: Date; cursor?: string }) {
    this.guard();
    const messages = [...this.msgs.values()].filter(m => new Date(m.date) >= opts.since && !m.isDraft);
    return { messages, done: true };
  }
  async incremental(state: SyncState) {
    this.guard();
    const cursor = typeof state.cursor === 'number' ? state.cursor : 0;
    const entries = this.log.filter(e => e.seq > cursor);
    const upserts = entries.filter(e => e.upsert).map(e => this.msgs.get(e.upsert!)!).filter(Boolean);
    const deletes = entries.filter(e => e.delete).map(e => e.delete!);
    return { upserts, deletes, state: { cursor: this.seq } };
  }
  async getBody(id: string) {
    this.guard(); const m = this.msgs.get(id); if (!m) throw new ProviderNotFoundError(id);
    return { html: m.html, text: m.text, attachments: m.attachments };
  }
  async getAttachment(id: string, attId: string) {
    this.guard(); const m = this.msgs.get(id); const meta = m?.attachments.find(a => a.attId === attId);
    if (!m || !meta) throw new ProviderNotFoundError(attId);
    const buf = m.attachmentBytes?.[attId] ?? Buffer.from('fake-bytes');
    return { stream: Readable.from(buf), mime: meta.mime, size: buf.length, name: meta.name };
  }
  async send(msg: OutgoingMessage) {
    this.guard(); this.sent.push(msg);
    const id = 'sent-' + uuidv4();
    const env: Seeded = { providerMessageId: id, messageIdHeader: msg.messageIdHeader, inReplyTo: msg.inReplyTo, references: msg.references ?? [],
      from: msg.from, to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, snippet: msg.text.slice(0, 200), date: new Date().toISOString(),
      isRead: true, isStarred: false, isDraft: false, sizeBytes: msg.html.length,
      attachments: msg.attachments.map((a, i): AttachmentMeta => ({ attId: 'att' + i, name: a.name, mime: a.mime, size: a.content.length })),
      folderProviderIds: ['SENT'], html: msg.html, text: msg.text };
    this.msgs.set(id, env); this.log.push({ seq: ++this.seq, upsert: id });
    return { providerMessageId: id };
  }
  async setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }) {
    this.guard(); ids.forEach(id => { const m = this.msgs.get(id); if (!m) return; if (flags.read !== undefined) m.isRead = flags.read; if (flags.starred !== undefined) m.isStarred = flags.starred; this.log.push({ seq: ++this.seq, upsert: id }); });
  }
  async move(ids: string[], folder: string) { this.guard(); ids.forEach(id => { const m = this.msgs.get(id); if (m) { m.folderProviderIds = [folder]; this.log.push({ seq: ++this.seq, upsert: id }); } }); }
  async archive(ids: string[]) { return this.move(ids, 'ARCHIVE'); }
  async trash(ids: string[]) { return this.move(ids, 'TRASH'); }
  async saveDraft(draft: OutgoingMessage, existing?: string) { this.guard(); const id = existing ?? 'draft-' + uuidv4(); this.drafts.set(id, draft); return { providerMessageId: id }; }
  async deleteDraft(id: string) { this.guard(); this.drafts.delete(id); }
  async search(query: string, opts: { before?: Date; limit: number }) {
    this.guard(); const q = query.toLowerCase();
    return [...this.msgs.values()].filter(m => (!opts.before || new Date(m.date) < opts.before) && (m.subject.toLowerCase().includes(q) || (m.text ?? '').toLowerCase().includes(q))).slice(0, opts.limit);
  }
}
```

```ts
// server/mail/providers/fakeRegistry.ts
import { FakeMailProvider } from './fake';
const fakes = new Map<string, FakeMailProvider>();
export function getFakeProvider(accountId: string): FakeMailProvider {
  let p = fakes.get(accountId); if (!p) { p = new FakeMailProvider(); p.seed([]); fakes.set(accountId, p); } return p;
}
export function resetFakes(): void { fakes.clear(); }
```

- [ ] **Step 4: Run** → `npx vitest run --project server server/mail/mime.test.ts server/mail/providers/fake.test.ts` → all pass.

- [ ] **Step 5: Commit**

```bash
git add server/mail/providers/types.ts server/mail/providers/fake.ts server/mail/providers/fakeRegistry.ts server/mail/providers/fake.test.ts server/mail/mime.ts server/mail/mime.test.ts
git commit -m "feat(mail): provider contract, MIME helpers, in-memory fake provider"
```

---
### Task 6: HTML sanitizer

**Files:**
- Create: `server/mail/sanitize.ts`
- Test: `server/mail/sanitize.test.ts`
- Modify: `package.json` (add `dompurify` runtime dep; `jsdom` moves from devDependencies to dependencies)

**Interfaces:**
- Produces: `sanitizeEmailHtml(html: string, opts: { attachmentUrl: (contentId: string) => string | null; allowRemoteImages: boolean }): { html: string; blockedRemoteImages: number }`.

- [ ] **Step 1: Install**

Run: `npm i dompurify && npm i jsdom && npm i -D @types/dompurify` (jsdom moves to `dependencies`; verify with `grep -n '"jsdom"' package.json`).

- [ ] **Step 2: Write the failing test**

```ts
// server/mail/sanitize.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml } from './sanitize';

const opts = { attachmentUrl: (cid: string) => (cid === 'img1' ? '/api/mail/messages/m/attachments/a1?inline=1' : null), allowRemoteImages: false };

describe('sanitizeEmailHtml', () => {
  it('drops scripts, forms, iframes and event handlers', () => {
    const r = sanitizeEmailHtml('<p onclick="x()">hi</p><script>bad()</script><form><input></form><iframe src="x"></iframe>', opts);
    expect(r.html).toBe('<p>hi</p>');
  });
  it('rewrites cid: images to the attachment route and blocks remote ones', () => {
    const r = sanitizeEmailHtml('<img src="cid:img1"><img src="https://t.example/p.png"><div style="background:url(https://t.example/b.png)">x</div>', opts);
    expect(r.html).toContain('src="/api/mail/messages/m/attachments/a1?inline=1"');
    expect(r.html).toContain('data-blocked-src="https://t.example/p.png"');
    expect(r.html).not.toContain('src="https://t.example/p.png"');
    expect(r.html).not.toContain('url(https://t.example/b.png)');
    expect(r.blockedRemoteImages).toBe(2);
  });
  it('keeps remote images when allowed', () => {
    const r = sanitizeEmailHtml('<img src="https://t.example/p.png">', { ...opts, allowRemoteImages: true });
    expect(r.html).toContain('src="https://t.example/p.png"'); expect(r.blockedRemoteImages).toBe(0);
  });
  it('forces links to open safely', () => {
    const r = sanitizeEmailHtml('<a href="https://x.y" target="_self">l</a><a href="javascript:alert(1)">j</a>', opts);
    expect(r.html).toContain('target="_blank"'); expect(r.html).toContain('rel="noopener noreferrer"'); expect(r.html).not.toContain('javascript:');
  });
  it('drops unknown cid: images', () => {
    expect(sanitizeEmailHtml('<img src="cid:nope">', opts).html).not.toContain('<img');
  });
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement**

```ts
// server/mail/sanitize.ts  (spec §4.3, §7)
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const window = new JSDOM('').window as unknown as Window & typeof globalThis;
const purify = createDOMPurify(window);
purify.setConfig({
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'svg', 'math'],
  FORBID_ATTR: ['srcset', 'ping', 'formaction', 'xlink:href'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target'],
});

const REMOTE = /^(https?:)?\/\//i;

export function sanitizeEmailHtml(html: string, opts: { attachmentUrl: (contentId: string) => string | null; allowRemoteImages: boolean }): { html: string; blockedRemoteImages: number } {
  let blocked = 0;
  const clean = purify.sanitize(html || '', { RETURN_DOM: true }) as unknown as HTMLElement;
  const doc = clean.ownerDocument!;
  clean.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (src.toLowerCase().startsWith('cid:')) {
      const url = opts.attachmentUrl(src.slice(4).replace(/^<|>$/g, ''));
      if (url) img.setAttribute('src', url); else img.remove();
    } else if (REMOTE.test(src)) {
      if (!opts.allowRemoteImages) { img.removeAttribute('src'); img.setAttribute('data-blocked-src', src); blocked++; }
    } else if (!src.startsWith('data:image/')) { img.remove(); }
  });
  clean.querySelectorAll<HTMLElement>('[style]').forEach(el => {
    const style = el.getAttribute('style') || '';
    if (/url\s*\(/i.test(style)) {
      if (!opts.allowRemoteImages && REMOTE.test(style.replace(/.*url\s*\(\s*['"]?/i, ''))) blocked++;
      el.setAttribute('style', style.replace(/[a-z-]*\s*:\s*[^;]*url\s*\([^)]*\)[^;]*;?/gi, ''));
    }
  });
  clean.querySelectorAll('a').forEach(a => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); });
  const wrapper = doc.createElement('div'); wrapper.append(...Array.from(clean.childNodes));
  return { html: wrapper.innerHTML, blockedRemoteImages: blocked };
}
```

If `purify.sanitize(..., { RETURN_DOM: true })` returns a `body` element, `clean.childNodes` is its content — the test asserting `<p>hi</p>` verifies that.

- [ ] **Step 5: Run** → all pass. Then `npm run lint` must be clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/mail/sanitize.ts server/mail/sanitize.test.ts
git commit -m "feat(mail): server-side email HTML sanitizer"
```

---

### Task 7: Sync engine (index writer)

**Files:**
- Create: `server/mail/sync/engine.ts`
- Modify: `server/realtime/changeFeed.ts:9-12` (add `'mailThread' | 'mailAccount'`), `src/hooks/useLiveQuery.ts:5-8` (same)
- Test: `server/mail/sync/engine.test.ts`

**Interfaces:**
- Consumes: `deriveThreadKey`, `mergeThreadKeys`, `normalizeMessageId`, `normalizeSubject` (Task 4); `MailProvider` (Task 5); accountStore (Task 3); `snippetOf` (Task 5).
- Produces:
  - `upsertFolders(db, accountId, folders: ProviderFolder[]): Map<string /*providerId*/, string /*local id*/>`
  - `upsertEnvelopes(ctx: MailContext, account: MailAccountRow, envelopes: Envelope[], opts?: { sentFromApp?: boolean }): { messageIds: string[]; threadKeys: string[] }` — writes messages, derives keys, merges, rebuilds `mail_threads` rows for affected keys, updates `mail_thread_reply_state` for linked keys, calls `onInboundLinked` hooks (registered via `registerInboundHook(fn)` — Plan 4 registers the RFI hook), broadcasts `mailThread` per key.
  - `removeMessages(ctx, account, providerMessageIds: string[]): void`
  - `rebuildThread(db, accountId, threadKey): void`
  - `runBackfill(ctx, account, provider): Promise<void>` — pages `provider.backfill({since: indexedSince})`, sets status `syncing`→`ok`, `lastSyncAt`.
  - `runIncremental(ctx, account, provider): Promise<void>` — `provider.incremental(JSON.parse(syncState))`, applies, stores new state.
  - `registerInboundHook(fn: (ctx: MailContext, ev: { threadKey: string; messageId: string; account: MailAccountRow }) => void): void`
  - `isInbound(db, env: Envelope): boolean` — `env.from.addr` not equal to any `mail_accounts.emailAddress`.

- [ ] **Step 1: Write the failing test**

```ts
// server/mail/sync/engine.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../../db';
import { runMigrations } from '../../migrations';
import { migrations } from '../../migrationList';
import { MailCrypto } from '../crypto';
import * as accounts from '../accountStore';
import { FakeMailProvider } from '../providers/fake';
import type { MailContext } from '../context';
import type { Envelope } from '../providers/types';
import { upsertFolders, upsertEnvelopes, runBackfill, runIncremental, registerInboundHook, removeMessages } from './engine';

let db: Database.Database; let ctx: MailContext; let acct: accounts.MailAccountRow; let provider: FakeMailProvider; let events: any[];
const crypto = new MailCrypto(Buffer.alloc(32, 9));
const env = (id: string, o: Partial<Envelope> = {}): Envelope => ({ providerMessageId: id, references: [], from: { addr: 'gc@teg.com', name: 'Mike' }, to: [{ addr: 'me@bb.com' }], cc: [], bcc: [],
  subject: 'Re: CO 4', snippet: 'ok', date: '2026-08-10T10:00:00.000Z', isRead: false, isStarred: false, isDraft: false, attachments: [], sizeBytes: 10, folderProviderIds: ['INBOX'], messageIdHeader: id + '@teg.com', ...o });

beforeEach(() => {
  db = openDb(':memory:'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-se-'));
  runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role, createdAt) VALUES ('u1','a','x','admin',1)`).run();
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@bb.com', auth: { refreshToken: 'r' }, indexedSince: '2026-06-01T00:00:00.000Z' });
  provider = new FakeMailProvider(); provider.seed([]);
  events = [];
  ctx = { db, dataDir: dir, crypto, providerFactory: () => provider, broadcastChange: e => events.push(e) };
});

describe('engine', () => {
  it('upsertFolders maps provider ids to local ids and is idempotent', () => {
    const m1 = upsertFolders(db, acct.id, [{ providerId: 'INBOX', name: 'Inbox', role: 'inbox' }]);
    const m2 = upsertFolders(db, acct.id, [{ providerId: 'INBOX', name: 'Inbox!', role: 'inbox' }]);
    expect(m1.get('INBOX')).toBe(m2.get('INBOX'));
    expect(db.prepare('SELECT name FROM mail_folders').get()).toEqual({ name: 'Inbox!' });
  });
  it('indexes envelopes into one thread via References and rolls up the thread row', () => {
    upsertFolders(db, acct.id, provider.folders);
    upsertEnvelopes(ctx, acct, [env('a', { messageIdHeader: 'root@bb.com', from: { addr: 'me@bb.com' }, isRead: true, date: '2026-08-01T00:00:00.000Z' }),
      env('b', { references: ['root@bb.com'], inReplyTo: 'root@bb.com', attachments: [{ attId: 'x', name: 'f.pdf', mime: 'application/pdf', size: 3 }] })]);
    const t = db.prepare('SELECT * FROM mail_threads').all() as any[];
    expect(t.length).toBe(1);
    expect(t[0]).toMatchObject({ threadKey: 'root@bb.com', messageCount: 2, unreadCount: 1, hasAttachments: 1, subject: 'CO 4', firstDate: '2026-08-01T00:00:00.000Z', lastDate: '2026-08-10T10:00:00.000Z' });
    expect(JSON.parse(t[0].participantsJson).map((p: any) => p.addr).sort()).toEqual(['gc@teg.com', 'me@bb.com']);
    expect(events.filter(e => e.type === 'mailThread').map(e => e.id)).toEqual(['root@bb.com']);
  });
  it('merges keys when the root arrives after the child', () => {
    upsertEnvelopes(ctx, acct, [env('child', { references: ['root@bb.com'] })]);
    expect((db.prepare('SELECT threadKey FROM mail_messages').get() as any).threadKey).toBe('root@bb.com');
    upsertEnvelopes(ctx, acct, [env('root', { messageIdHeader: 'root@bb.com', date: '2026-08-01T00:00:00.000Z' })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_threads').get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_messages WHERE threadKey='root@bb.com'`).get()).toEqual({ c: 2 });
  });
  it('re-upserting the same provider id updates flags instead of duplicating', () => {
    upsertEnvelopes(ctx, acct, [env('a')]);
    upsertEnvelopes(ctx, acct, [env('a', { isRead: true, isStarred: true })]);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT isRead, isStarred FROM mail_messages').get()).toEqual({ isRead: 1, isStarred: 1 });
    expect(db.prepare('SELECT unreadCount FROM mail_threads').get()).toEqual({ unreadCount: 0 });
  });
  it('writes reply-state and fires inbound hooks only for linked threads', () => {
    const seen: string[] = [];
    registerInboundHook((_c, ev) => seen.push(ev.threadKey));
    db.prepare(`INSERT INTO mail_thread_links (id, threadKey, itemType, itemId, linkedByUserId, createdAt) VALUES ('l','linked@bb.com','rfi','r1','u1','t')`).run();
    upsertEnvelopes(ctx, acct, [env('x', { references: ['linked@bb.com'] }), env('y', { messageIdHeader: 'other@bb.com' })]);
    expect(seen).toEqual(['linked@bb.com']);
    expect(db.prepare(`SELECT lastInboundDate FROM mail_thread_reply_state WHERE threadKey='linked@bb.com'`).get()).toEqual({ lastInboundDate: '2026-08-10T10:00:00.000Z' });
    expect(db.prepare(`SELECT COUNT(*) c FROM mail_thread_reply_state WHERE threadKey='other@bb.com'`).get()).toEqual({ c: 0 });
  });
  it('outbound (own address) messages update lastOutboundDate, not inbound', () => {
    db.prepare(`INSERT INTO mail_thread_links (id, threadKey, itemType, itemId, linkedByUserId, createdAt) VALUES ('l','k@bb.com','rfi','r1','u1','t')`).run();
    upsertEnvelopes(ctx, acct, [env('o', { messageIdHeader: 'k@bb.com', from: { addr: 'me@bb.com' } })]);
    expect(db.prepare(`SELECT lastInboundDate, lastOutboundDate FROM mail_thread_reply_state WHERE threadKey='k@bb.com'`).get()).toEqual({ lastInboundDate: null, lastOutboundDate: '2026-08-10T10:00:00.000Z' });
  });
  it('runBackfill honours indexedSince, folders, status transitions', async () => {
    provider.seed([env('old', { date: '2026-01-01T00:00:00.000Z' }), env('new')]);
    await runBackfill(ctx, acct, provider);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM mail_folders').get()).toEqual({ c: 5 });
    const a = accounts.getAccountAny(db, acct.id)!; expect(a.status).toBe('ok'); expect(a.lastSyncAt).toBeTruthy();
    expect(events.some(e => e.type === 'mailAccount' && e.id === acct.id)).toBe(true);
  });
  it('runIncremental applies upserts/deletes and persists state', async () => {
    await runBackfill(ctx, acct, provider);
    provider.injectInbound(env('n1'));
    await runIncremental(ctx, acct, provider);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    expect(JSON.parse(accounts.getAccountAny(db, acct.id)!.syncState!)).toEqual({ cursor: 1 });
    removeMessages(ctx, acct, ['n1']);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM mail_threads').get()).toEqual({ c: 0 });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// server/mail/sync/engine.ts  (spec §4.2, §3.1, §3 reply-state rule)
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { MailContext } from '../context';
import type { MailAccountRow } from '../accountStore';
import * as accounts from '../accountStore';
import type { Envelope, MailProvider, ProviderFolder } from '../providers/types';
import { AuthExpiredError } from '../providers/types';
import { deriveThreadKey, mergeThreadKeys, normalizeMessageId, normalizeSubject } from '../threadKey';
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
  const own = db.prepare('SELECT 1 FROM mail_accounts WHERE emailAddress = ?').get((env.from?.addr || '').toLowerCase());
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
    if (!subject && r.subject) subject = r.subject.replace(/^((re|fw|fwd)\s*:\s*)+/i, '').trim();
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO mail_threads (id, accountId, threadKey, subject, firstDate, lastDate, messageCount, unreadCount, hasAttachments, isStarred, participantsJson, folderIdsJson, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(accountId, threadKey) DO UPDATE SET subject=excluded.subject, firstDate=excluded.firstDate, lastDate=excluded.lastDate, messageCount=excluded.messageCount,
                unreadCount=excluded.unreadCount, hasAttachments=excluded.hasAttachments, isStarred=excluded.isStarred, participantsJson=excluded.participantsJson, folderIdsJson=excluded.folderIdsJson, updatedAt=excluded.updatedAt`)
    .run(uuidv4(), accountId, threadKey, subject, rows[0].date, rows[rows.length - 1].date, rows.length, unread, hasAtt, starred, JSON.stringify([...participants.values()]), JSON.stringify([...folders]), now);
}

export function upsertEnvelopes(ctx: MailContext, account: MailAccountRow, envelopes: Envelope[], opts: { sentFromApp?: boolean } = {}): { messageIds: string[]; threadKeys: string[] } {
  const { db } = ctx;
  const fmap = folderMap(db, account.id);
  const touched = new Set<string>();
  const messageIds: string[] = [];
  const inboundEvents: { threadKey: string; messageId: string }[] = [];
  const lookup = (mid: string) => (db.prepare('SELECT threadKey FROM mail_messages WHERE accountId = ? AND messageIdHeader = ?').get(account.id, mid) as { threadKey: string } | undefined)?.threadKey ?? null;
  const tx = db.transaction(() => {
    for (const env of envelopes) {
      const mid = normalizeMessageId(env.messageIdHeader);
      const { threadKey } = deriveThreadKey(lookup, { messageIdHeader: mid, inReplyTo: env.inReplyTo ?? null, references: env.references ?? [], fallbackSeed: account.id + ':' + env.providerMessageId });
      // Late root: children were keyed on THIS message's id before it arrived.
      if (mid && mid !== threadKey) {
        const orphanKey = (db.prepare('SELECT 1 FROM mail_messages WHERE accountId = ? AND threadKey = ?').get(account.id, mid)) ? mid : null;
        if (orphanKey) { mergeThreadKeys(db, account.id, orphanKey, threadKey); touched.add(orphanKey); }
      } else if (mid && mid === threadKey) {
        // This message IS the root; anything already keyed by a reference chain pointing at it is already on `mid`.
      }
      const existing = db.prepare('SELECT id, threadKey FROM mail_messages WHERE accountId = ? AND providerMessageId = ?').get(account.id, env.providerMessageId) as { id: string; threadKey: string } | undefined;
      const id = existing?.id ?? uuidv4();
      const now = new Date().toISOString();
      const folderIds = (env.folderProviderIds || []).map(p => fmap.get(p)).filter((x): x is string => !!x);
      const values = [account.id, env.providerMessageId, env.providerThreadId ?? null, mid, normalizeMessageId(env.inReplyTo), JSON.stringify((env.references || []).map(normalizeMessageId).filter(Boolean)), threadKey,
        env.from?.addr?.toLowerCase() ?? null, env.from?.name ?? null, JSON.stringify(env.to || []), JSON.stringify(env.cc || []), JSON.stringify(env.bcc || []),
        env.subject || '', snippetOf(env.snippet || ''), env.date, env.isRead ? 1 : 0, env.isStarred ? 1 : 0, env.isDraft ? 1 : 0,
        env.attachments?.length ? 1 : 0, JSON.stringify(env.attachments || []), env.sizeBytes || 0, JSON.stringify(folderIds), opts.sentFromApp ? 1 : 0];
      if (existing) {
        db.prepare(`UPDATE mail_messages SET accountId=?, providerMessageId=?, providerThreadId=?, messageIdHeader=?, inReplyTo=?, referencesJson=?, threadKey=?, fromAddr=?, fromName=?, toJson=?, ccJson=?, bccJson=?,
          subject=?, snippet=?, date=?, isRead=?, isStarred=?, isDraft=?, hasAttachments=?, attachmentsJson=?, sizeBytes=?, folderIdsJson=?, sentFromApp=MAX(sentFromApp, ?), updatedAt=? WHERE id=?`).run(...values, now, id);
        if (existing.threadKey !== threadKey) touched.add(existing.threadKey);
      } else {
        db.prepare(`INSERT INTO mail_messages (accountId, providerMessageId, providerThreadId, messageIdHeader, inReplyTo, referencesJson, threadKey, fromAddr, fromName, toJson, ccJson, bccJson,
          subject, snippet, date, isRead, isStarred, isDraft, hasAttachments, attachmentsJson, sizeBytes, folderIdsJson, sentFromApp, id, createdAt, updatedAt) VALUES (${values.map(() => '?').join(',')}, ?, ?, ?)`).run(...values, id, now, now);
        // Reply-state + hooks only for NEW messages on linked threads.
        const linked = db.prepare('SELECT 1 FROM mail_thread_links WHERE threadKey = ? LIMIT 1').get(threadKey);
        if (linked) {
          const inbound = isInbound(db, env);
          db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)').run(threadKey, now);
          db.prepare(`UPDATE mail_thread_reply_state SET ${inbound ? 'lastInboundDate' : 'lastOutboundDate'} = MAX(COALESCE(${inbound ? 'lastInboundDate' : 'lastOutboundDate'}, ''), ?), updatedAt = ? WHERE threadKey = ?`).run(env.date, now, threadKey);
          if (inbound) inboundEvents.push({ threadKey, messageId: id });
        }
      }
      messageIds.push(id); touched.add(threadKey);
    }
    for (const key of touched) rebuildThread(db, account.id, key);
  });
  tx();
  for (const key of touched) ctx.broadcastChange({ type: 'mailThread', id: key, action: 'updated', byUserId: account.userId });
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
```

Add `'mailThread' | 'mailAccount'` to the `EntityType` unions in `server/realtime/changeFeed.ts` and `src/hooks/useLiveQuery.ts`.

- [ ] **Step 4: Run** → `npx vitest run --project server server/mail/sync/engine.test.ts` → 8 passed. Fix the folder-count assertion if the fake's folder list differs from 5.

- [ ] **Step 5: Commit**

```bash
git add server/mail/sync/engine.ts server/mail/sync/engine.test.ts server/realtime/changeFeed.ts src/hooks/useLiveQuery.ts
git commit -m "feat(mail): sync engine — envelope index, thread rollups, reply state, inbound hooks"
```

---

### Task 8: Scheduler and body cache

**Files:**
- Create: `server/mail/sync/scheduler.ts`, `server/mail/sync/bodyCache.ts`
- Test: `server/mail/sync/scheduler.test.ts`, `server/mail/sync/bodyCache.test.ts`

**Interfaces:**
- Produces:
  - `class MailScheduler { constructor(ctx: MailContext, opts?: { fastMs?: number; slowMs?: number; backoffMaxMs?: number; now?: () => number }); start(): void; stop(): Promise<void>; startAccount(accountId: string): void; stopAccount(accountId: string): void; markViewed(accountIds: string[]): void; pokeAccount(accountId: string): void; getProvider(accountId: string): MailProvider }` — `start()` loads `listActiveAccounts` and starts a worker each; a worker runs `runBackfill` once (if `syncState` is null) then `runIncremental` on a timer: `fastMs` (30 s) while `markViewed` was called within the last 60 s, else `slowMs` (5 min); errors → exponential backoff with jitter capped at `backoffMaxMs` (10 min); `AuthExpiredError` stops the worker. `pokeAccount` runs an incremental immediately (webhooks/IDLE use it). Providers are created once per worker via `ctx.providerFactory(account, readAuth(...))` and cached; `getProvider` is what routes use for body/attachment/actions (creating on demand for accounts without a running worker, e.g. `needs_review` during "Test & activate").
  - `class BodyCache { constructor(opts: { maxBytes: number; ttlMs: number }); get(key: string): T | undefined; set(key: string, value: T, bytes: number): void; delete(key: string): void }`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/mail/sync/bodyCache.test.ts
import { describe, it, expect } from 'vitest';
import { BodyCache } from './bodyCache';
describe('BodyCache', () => {
  it('evicts least-recently-used when over budget', () => {
    const c = new BodyCache<string>({ maxBytes: 10, ttlMs: 60_000 });
    c.set('a', 'A', 4); c.set('b', 'B', 4); c.get('a'); c.set('c', 'C', 4);
    expect(c.get('b')).toBeUndefined(); expect(c.get('a')).toBe('A'); expect(c.get('c')).toBe('C');
  });
  it('expires entries after ttl', () => {
    let now = 0; const c = new BodyCache<string>({ maxBytes: 100, ttlMs: 10, now: () => now });
    c.set('a', 'A', 1); now = 11; expect(c.get('a')).toBeUndefined();
  });
});
```

```ts
// server/mail/sync/scheduler.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { openDb } from '../../db'; import { runMigrations } from '../../migrations'; import { migrations } from '../../migrationList';
import { MailCrypto } from '../crypto'; import * as accounts from '../accountStore';
import { FakeMailProvider } from '../providers/fake'; import { AuthExpiredError } from '../providers/types';
import { MailScheduler } from './scheduler';
import type { MailContext } from '../context';

const crypto = new MailCrypto(Buffer.alloc(32, 4));
let ctx: MailContext; let provider: FakeMailProvider; let acct: accounts.MailAccountRow;
const env = (id: string) => ({ providerMessageId: id, references: [], from: { addr: 'x@y' }, to: [], cc: [], bcc: [], subject: 's', snippet: '', date: new Date().toISOString(), isRead: false, isStarred: false, isDraft: false, attachments: [], sizeBytes: 1, folderProviderIds: ['INBOX'], messageIdHeader: id + '@y' });
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  const db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sc-')), migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role, createdAt) VALUES ('u1','a','x','admin',1)`).run();
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@bb.com', auth: { refreshToken: 'r' } });
  provider = new FakeMailProvider(); provider.seed([env('seeded')]);
  ctx = { db, dataDir: '', crypto, providerFactory: () => provider, broadcastChange: () => {} };
});

describe('MailScheduler', () => {
  it('backfills on start, then polls incrementally on the slow timer', async () => {
    vi.useFakeTimers();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await flush(); await flush();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    provider.injectInbound(env('later'));
    await vi.advanceTimersByTimeAsync(5001); await flush();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
    await s.stop(); vi.useRealTimers();
  });
  it('uses the fast timer while viewed and poke runs immediately', async () => {
    vi.useFakeTimers();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await flush(); await flush();
    s.markViewed([acct.id]); provider.injectInbound(env('fast'));
    await vi.advanceTimersByTimeAsync(1001); await flush();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
    provider.injectInbound(env('poked')); s.pokeAccount(acct.id); await flush(); await flush();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 3 });
    await s.stop(); vi.useRealTimers();
  });
  it('stops the worker and flags auth_error on AuthExpiredError', async () => {
    vi.useFakeTimers();
    provider.failNextWith(new AuthExpiredError('expired'));
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await flush(); await flush();
    expect(accounts.getAccountAny(ctx.db, acct.id)!.status).toBe('auth_error');
    expect(s.isRunning(acct.id)).toBe(false);
    await s.stop(); vi.useRealTimers();
  });
  it('getProvider creates a provider for an account without a worker', () => {
    const s = new MailScheduler(ctx);
    expect(s.getProvider(acct.id)).toBe(provider);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// server/mail/sync/bodyCache.ts
export class BodyCache<T> {
  private map = new Map<string, { value: T; bytes: number; at: number }>();
  private total = 0;
  private readonly now: () => number;
  constructor(private opts: { maxBytes: number; ttlMs: number; now?: () => number }) { this.now = opts.now ?? (() => Date.now()); }
  get(key: string): T | undefined {
    const e = this.map.get(key); if (!e) return undefined;
    if (this.now() - e.at > this.opts.ttlMs) { this.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, e);   // refresh recency
    return e.value;
  }
  set(key: string, value: T, bytes: number): void {
    this.delete(key);
    this.map.set(key, { value, bytes, at: this.now() }); this.total += bytes;
    for (const [k, e] of this.map) { if (this.total <= this.opts.maxBytes) break; this.map.delete(k); this.total -= e.bytes; }
  }
  delete(key: string): void { const e = this.map.get(key); if (e) { this.map.delete(key); this.total -= e.bytes; } }
}
```

```ts
// server/mail/sync/scheduler.ts  (spec §4.2 freshness table; providers push via pokeAccount)
import type { MailContext } from '../context';
import * as accounts from '../accountStore';
import type { MailProvider } from '../providers/types';
import { AuthExpiredError } from '../providers/types';
import { runBackfill, runIncremental } from './engine';

interface Worker { accountId: string; provider: MailProvider; timer: NodeJS.Timeout | null; failures: number; running: Promise<void> | null; stopped: boolean }

export class MailScheduler {
  private workers = new Map<string, Worker>();
  private providers = new Map<string, MailProvider>();
  private viewedAt = new Map<string, number>();
  private readonly fastMs: number; private readonly slowMs: number; private readonly backoffMaxMs: number; private readonly now: () => number;
  constructor(private ctx: MailContext, opts: { fastMs?: number; slowMs?: number; backoffMaxMs?: number; now?: () => number } = {}) {
    this.fastMs = opts.fastMs ?? 30_000; this.slowMs = opts.slowMs ?? 300_000; this.backoffMaxMs = opts.backoffMaxMs ?? 600_000; this.now = opts.now ?? (() => Date.now());
  }
  start(): void { for (const a of accounts.listActiveAccounts(this.ctx.db)) this.startAccount(a.id); }
  async stop(): Promise<void> { for (const id of [...this.workers.keys()]) this.stopAccount(id); await Promise.all([...this.workers.values()].map(w => w.running ?? Promise.resolve())); }
  isRunning(accountId: string): boolean { const w = this.workers.get(accountId); return !!w && !w.stopped; }
  markViewed(accountIds: string[]): void { accountIds.forEach(id => this.viewedAt.set(id, this.now())); }
  getProvider(accountId: string): MailProvider {
    let p = this.providers.get(accountId);
    if (!p) {
      const account = accounts.getAccountAny(this.ctx.db, accountId); if (!account) throw new Error('Account not found');
      const auth = accounts.readAuth(this.ctx.db, this.ctx.crypto, accountId)!;
      p = this.ctx.providerFactory(account, auth); this.providers.set(accountId, p);
    }
    return p;
  }
  dropProvider(accountId: string): void { this.providers.delete(accountId); }
  startAccount(accountId: string): void {
    if (this.workers.has(accountId)) return;
    const w: Worker = { accountId, provider: this.getProvider(accountId), timer: null, failures: 0, running: null, stopped: false };
    this.workers.set(accountId, w);
    void this.tick(w, true);
  }
  stopAccount(accountId: string): void {
    const w = this.workers.get(accountId); if (!w) return;
    w.stopped = true; if (w.timer) clearTimeout(w.timer); w.timer = null;
    this.workers.delete(accountId);
  }
  pokeAccount(accountId: string): void { const w = this.workers.get(accountId); if (w && !w.running) { if (w.timer) clearTimeout(w.timer); void this.tick(w, false); } }
  private schedule(w: Worker): void {
    if (w.stopped) return;
    const viewed = (this.now() - (this.viewedAt.get(w.accountId) ?? -Infinity)) < 60_000;
    let delay = viewed ? this.fastMs : this.slowMs;
    if (w.failures) delay = Math.min(this.backoffMaxMs, delay * 2 ** w.failures) * (0.8 + Math.random() * 0.4);
    w.timer = setTimeout(() => void this.tick(w, false), delay);
  }
  private async tick(w: Worker, first: boolean): Promise<void> {
    if (w.stopped || w.running) return;
    w.running = (async () => {
      const account = accounts.getAccountAny(this.ctx.db, w.accountId);
      if (!account) { this.stopAccount(w.accountId); return; }
      try {
        if (first && !account.syncState) await runBackfill(this.ctx, account, w.provider); else await runIncremental(this.ctx, account, w.provider);
        w.failures = 0;
      } catch (e) {
        if (e instanceof AuthExpiredError) { this.stopAccount(w.accountId); this.providers.delete(w.accountId); return; }
        w.failures = Math.min(w.failures + 1, 6);
        console.error(`[mail] sync failed for ${w.accountId}:`, (e as Error).message);
      }
    })();
    try { await w.running; } finally { w.running = null; this.schedule(w); }
  }
}
```

- [ ] **Step 4: Run** → both test files pass. If the fake-timer test is flaky on `flush()`, replace the two `await flush()` calls with `await vi.runOnlyPendingTimersAsync()` + `await flush()`.

- [ ] **Step 5: Commit**

```bash
git add server/mail/sync/scheduler.ts server/mail/sync/scheduler.test.ts server/mail/sync/bodyCache.ts server/mail/sync/bodyCache.test.ts
git commit -m "feat(mail): per-account sync scheduler with fast/slow polling and backoff; body LRU cache"
```

---
### Task 9: Thread links + chain resolution

**Files:**
- Create: `server/mail/links.ts`
- Test: `server/mail/links.test.ts`

**Interfaces:**
- Produces:
  - `type ItemType = 'proposal'|'invoice'|'changeOrder'|'payApp'|'issue'|'rfi'|'dailyReport'|'punch'|'task'|'project'|'customer'`
  - `resolveChain(db, itemType, itemId): { projectId: string | null; customerId: string | null }` — table lookup: `proposal→proposals.projectId`, `invoice→invoices`, `changeOrder→change_orders`, `payApp→aia_pay_apps`, `issue→issues`, `rfi→rfis`, `dailyReport→daily_reports`, `punch→projectId is the itemId`, `task→tasks.projectId/customerId`, `project→itemId`, `customer→customerId=itemId`; project → `projects.customerId` (ignore `'customer-unassigned'`). Verify each table/column name with `grep -n "CREATE TABLE" server/migrationList.ts` before coding.
  - `createLink(db, input: { threadKey; itemType; itemId; linkedByUserId; subjectSnapshot?; firstDate?; participants?: Addr[] }): LinkRow` (idempotent on the unique key — returns the existing row)
  - `listLinksForItem(db, itemType, itemId): LinkRow[]`, `listLinksForThread(db, threadKey): LinkRow[]`, `deleteLink(db, id): void`
  - `LinkRow = { id, threadKey, subjectSnapshot, firstDate, participantsJson, itemType, itemId, projectId, customerId, linkedByUserId, createdAt }`

- [ ] **Step 1: Write the failing test**

```ts
// server/mail/links.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db'; import { runMigrations } from '../migrations'; import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { saveCustomer } from '../customerStore';
import { createRfi } from '../rfiStore';
import { resolveChain, createLink, listLinksForItem, listLinksForThread, deleteLink } from './links';

let db: Database.Database; let projectId: string; let customerId: string; let rfiId: string;
beforeEach(() => {
  db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ln-')), migrations);
  customerId = 'c1'; saveCustomer(db, { id: 'c1', name: 'TEG' } as any);   // saveCustomer(db, c: Customer) — server/customerStore.ts:55; fill required fields if it throws
  projectId = 'p1'; createProject(db, { id: projectId, name: 'Dania', createdAt: 1, customerId, pages: [], takeoffs: [] } as any);
  rfiId = createRfi(db, projectId, { title: 'Ceilings' }).id;
});
describe('links', () => {
  it('resolves rfi → project → customer', () => {
    expect(resolveChain(db, 'rfi', rfiId)).toEqual({ projectId, customerId });
    expect(resolveChain(db, 'project', projectId)).toEqual({ projectId, customerId });
    expect(resolveChain(db, 'customer', customerId)).toEqual({ projectId: null, customerId });
    expect(resolveChain(db, 'rfi', 'missing')).toEqual({ projectId: null, customerId: null });
  });
  it('createLink is idempotent and denormalizes the chain', () => {
    const a = createLink(db, { threadKey: 'k', itemType: 'rfi', itemId: rfiId, linkedByUserId: 'u1', subjectSnapshot: 'RFI-001' });
    const b = createLink(db, { threadKey: 'k', itemType: 'rfi', itemId: rfiId, linkedByUserId: 'u2' });
    expect(b.id).toBe(a.id); expect(a.projectId).toBe(projectId); expect(a.customerId).toBe(customerId);
    expect(listLinksForItem(db, 'rfi', rfiId).length).toBe(1);
    expect(listLinksForThread(db, 'k').map(l => l.itemType)).toEqual(['rfi']);
    deleteLink(db, a.id); expect(listLinksForThread(db, 'k')).toEqual([]);
  });
});
```

Adjust the `saveCustomer`/`createProject` calls to the real signatures (`server/customerStore.ts:44-80`, `server/projectStore.ts`) — the point is a customer, a project linked to it, and an RFI in that project.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// server/mail/links.ts  (spec §3 mail_thread_links)
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Addr } from './providers/types';

export type ItemType = 'proposal' | 'invoice' | 'changeOrder' | 'payApp' | 'issue' | 'rfi' | 'dailyReport' | 'punch' | 'task' | 'project' | 'customer';
export interface LinkRow { id: string; threadKey: string; subjectSnapshot: string | null; firstDate: string | null; participantsJson: string; itemType: ItemType; itemId: string; projectId: string | null; customerId: string | null; linkedByUserId: string; createdAt: string }

const ITEM_TABLE: Partial<Record<ItemType, string>> = { proposal: 'proposals', invoice: 'invoices', changeOrder: 'change_orders', payApp: 'aia_pay_apps', issue: 'issues', rfi: 'rfis', dailyReport: 'daily_reports', task: 'tasks' };
const UNASSIGNED = 'customer-unassigned';

export function resolveChain(db: Database.Database, itemType: ItemType, itemId: string): { projectId: string | null; customerId: string | null } {
  let projectId: string | null = null; let customerId: string | null = null;
  if (itemType === 'customer') return { projectId: null, customerId: itemId };
  if (itemType === 'project' || itemType === 'punch') projectId = itemId;
  else if (itemType === 'task') {
    const t = db.prepare('SELECT projectId, customerId FROM tasks WHERE id = ?').get(itemId) as { projectId: string | null; customerId: string | null } | undefined;
    projectId = t?.projectId ?? null; customerId = t?.customerId ?? null;
  } else {
    const table = ITEM_TABLE[itemType]!;
    const r = db.prepare(`SELECT projectId FROM ${table} WHERE id = ?`).get(itemId) as { projectId: string } | undefined;
    projectId = r?.projectId ?? null;
  }
  if (projectId) {
    const p = db.prepare('SELECT customerId FROM projects WHERE id = ?').get(projectId) as { customerId: string | null } | undefined;
    if (!p) projectId = null; else if (p.customerId && p.customerId !== UNASSIGNED) customerId = customerId ?? p.customerId;
  }
  return { projectId, customerId };
}

export function createLink(db: Database.Database, input: { threadKey: string; itemType: ItemType; itemId: string; linkedByUserId: string; subjectSnapshot?: string | null; firstDate?: string | null; participants?: Addr[] }): LinkRow {
  const existing = db.prepare('SELECT * FROM mail_thread_links WHERE threadKey = ? AND itemType = ? AND itemId = ?').get(input.threadKey, input.itemType, input.itemId) as LinkRow | undefined;
  if (existing) return existing;
  const chain = resolveChain(db, input.itemType, input.itemId);
  const id = uuidv4();
  db.prepare(`INSERT INTO mail_thread_links (id, threadKey, subjectSnapshot, firstDate, participantsJson, itemType, itemId, projectId, customerId, linkedByUserId, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.threadKey, input.subjectSnapshot ?? null, input.firstDate ?? null, JSON.stringify(input.participants ?? []), input.itemType, input.itemId, chain.projectId, chain.customerId, input.linkedByUserId, new Date().toISOString());
  return db.prepare('SELECT * FROM mail_thread_links WHERE id = ?').get(id) as LinkRow;
}
export function listLinksForItem(db: Database.Database, itemType: ItemType, itemId: string): LinkRow[] {
  return db.prepare('SELECT * FROM mail_thread_links WHERE itemType = ? AND itemId = ? ORDER BY createdAt').all(itemType, itemId) as LinkRow[];
}
export function listLinksForThread(db: Database.Database, threadKey: string): LinkRow[] {
  return db.prepare('SELECT * FROM mail_thread_links WHERE threadKey = ? ORDER BY createdAt').all(threadKey) as LinkRow[];
}
export function deleteLink(db: Database.Database, id: string): void { db.prepare('DELETE FROM mail_thread_links WHERE id = ?').run(id); }
```

- [ ] **Step 4: Run** → pass.
- [ ] **Step 5: Commit** — `git add server/mail/links.ts server/mail/links.test.ts && git commit -m "feat(mail): thread links with project/customer chain resolution"`

---

### Task 10: Item send effects (§4.6)

**Files:**
- Create: `server/mail/itemSendEffects.ts`
- Test: `server/mail/itemSendEffects.test.ts`

**Interfaces:**
- Consumes: `markSent` (`server/proposalStore.ts` — confirm export name with `grep -n "export function markSent" server/*.ts`), `setInvoiceStatus`, `setChangeOrderStatus`, `markIssueSent`, `markRfiSent`, `logActivity`, getters `getProposal/getInvoice/getChangeOrder/getIssue/getRfi/getDailyReport` (all imported at the top of `server/routes.ts` — copy the import lines), `resolveChain`.
- Produces: `applySendEffects(db, input: { itemType: ItemType; itemId: string; userId: string; role: string; to: string; threadKey: string }): { applied: boolean; skipped?: 'role' | 'noop' | 'missing'; broadcast?: { type: EntityType; id: string; projectId?: string; version?: number } }`. `ADMIN_ITEM_TYPES = ['proposal','invoice','changeOrder','payApp']`.

- [ ] **Step 1: Write the failing test**

```ts
// server/mail/itemSendEffects.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db'; import { runMigrations } from '../migrations'; import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { createRfi, getRfi } from '../rfiStore';
import { createIssue, getIssue } from '../issueStore';
import { applySendEffects } from './itemSendEffects';

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ise-')), migrations);
  createProject(db, { id: 'p1', name: 'P', createdAt: 1, pages: [], takeoffs: [] } as any);
});
describe('applySendEffects', () => {
  it('marks an open RFI sent and logs activity', () => {
    const { id } = createRfi(db, 'p1', { title: 'x' });
    const r = applySendEffects(db, { itemType: 'rfi', itemId: id, userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' });
    expect(r.applied).toBe(true); expect(getRfi(db, id).status).toBe('sent');
    expect(r.broadcast).toMatchObject({ type: 'rfi', id, projectId: 'p1' });
    expect((db.prepare(`SELECT type FROM activity WHERE projectId='p1'`).all() as any[]).map(a => a.type)).toContain('rfi_sent');
  });
  it('is idempotent: an answered RFI is left alone (noop) but activity still logs', () => {
    const { id } = createRfi(db, 'p1', { title: 'x', status: 'answered' });
    const r = applySendEffects(db, { itemType: 'rfi', itemId: id, userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' });
    expect(getRfi(db, id).status).toBe('answered'); expect(r.applied).toBe(true);
  });
  it('skips admin-gated item types for non-admins', () => {
    const r = applySendEffects(db, { itemType: 'invoice', itemId: 'inv-missing', userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' });
    expect(r).toEqual({ applied: false, skipped: 'role' });
  });
  it('reports missing items', () => {
    expect(applySendEffects(db, { itemType: 'issue', itemId: 'nope', userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' })).toEqual({ applied: false, skipped: 'missing' });
  });
  it('link-only types are a noop', () => {
    expect(applySendEffects(db, { itemType: 'project', itemId: 'p1', userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' })).toEqual({ applied: false, skipped: 'noop' });
  });
});
```

Confirm `createIssue`/`createRfi` signatures (`server/issueStore.ts`, `server/rfiStore.ts:36`) before running.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// server/mail/itemSendEffects.ts  (spec §4.6 — the ONE place item "sent" side effects live)
import type Database from 'better-sqlite3';
import { logActivity } from '../activity';
import { getProposal, markSent as markProposalSent } from '../proposalStore';
import { getInvoice, setInvoiceStatus, getChangeOrder, setChangeOrderStatus } from '../billingStore';
import { getIssue, markIssueSent } from '../issueStore';
import { getRfi, markRfiSent } from '../rfiStore';
import { getDailyReport } from '../dailyReportStore';
import type { EntityType } from '../realtime/changeFeed';
import type { ItemType } from './links';
// Verified locations: proposalStore.ts:126/311, billingStore.ts:64/199/263/339,
// issueStore.ts (getIssue, markIssueSent:112), rfiStore.ts, dailyReportStore.ts:39.

export const ADMIN_ITEM_TYPES: ItemType[] = ['proposal', 'invoice', 'changeOrder', 'payApp'];

export interface SendEffectsInput { itemType: ItemType; itemId: string; userId: string; role: string; to: string; threadKey: string }
export interface SendEffectsResult { applied: boolean; skipped?: 'role' | 'noop' | 'missing'; broadcast?: { type: EntityType; id: string; projectId?: string; version?: number } }

const pad3 = (n: number) => String(n).padStart(3, '0');

export function applySendEffects(db: Database.Database, i: SendEffectsInput): SendEffectsResult {
  if (ADMIN_ITEM_TYPES.includes(i.itemType) && i.role !== 'admin') return { applied: false, skipped: 'role' };
  switch (i.itemType) {
    case 'proposal': {
      const p = getProposal(db, i.itemId); if (!p) return { applied: false, skipped: 'missing' };
      let version = p.version;
      if (!p.legacy && p.status === 'draft') version = markProposalSent(db, p.id, { to: i.to, subject: '' }).version;
      logActivity(db, { projectId: p.projectId, userId: i.userId, type: 'proposal_sent', message: `Proposal #${p.number} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'proposal', id: p.id, projectId: p.projectId, version } };
    }
    case 'invoice': {
      const inv = getInvoice(db, i.itemId); if (!inv) return { applied: false, skipped: 'missing' };
      if (inv.status !== 'sent' && inv.status !== 'paid') { try { setInvoiceStatus(db, inv.id, 'sent'); } catch { /* best effort */ } }
      logActivity(db, { projectId: inv.projectId, userId: i.userId, type: 'invoice_sent', message: `Invoice ${inv.number ?? ''} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'invoice', id: inv.id, projectId: inv.projectId, version: getInvoice(db, inv.id)?.version } };
    }
    case 'changeOrder': {
      const co = getChangeOrder(db, i.itemId); if (!co) return { applied: false, skipped: 'missing' };
      if (!['sent', 'approved', 'rejected'].includes(co.status)) { try { setChangeOrderStatus(db, co.id, 'sent'); } catch { /* best effort */ } }
      logActivity(db, { projectId: co.projectId, userId: i.userId, type: 'change_order_sent', message: `Change Order ${co.number ?? ''} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'changeOrder', id: co.id, projectId: co.projectId, version: getChangeOrder(db, co.id)?.version } };
    }
    case 'issue': {
      const iss = getIssue(db, i.itemId); if (!iss) return { applied: false, skipped: 'missing' };
      try { markIssueSent(db, iss.id); } catch { /* best effort */ }
      logActivity(db, { projectId: iss.projectId, userId: i.userId, type: 'issue_sent', message: `Issue ISS-${pad3(iss.number)} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'issue', id: iss.id, projectId: iss.projectId, version: getIssue(db, iss.id)?.version } };
    }
    case 'rfi': {
      const rfi = getRfi(db, i.itemId); if (!rfi) return { applied: false, skipped: 'missing' };
      try { markRfiSent(db, rfi.id); } catch { /* best effort */ }
      logActivity(db, { projectId: rfi.projectId, userId: i.userId, type: 'rfi_sent', message: `RFI RFI-${pad3(rfi.number)} emailed to ${i.to}` });
      return { applied: true, broadcast: { type: 'rfi', id: rfi.id, projectId: rfi.projectId, version: getRfi(db, rfi.id)?.version } };
    }
    case 'dailyReport': {
      const r = getDailyReport(db, i.itemId); if (!r) return { applied: false, skipped: 'missing' };
      logActivity(db, { projectId: r.projectId, userId: i.userId, type: 'daily_report_sent', message: `Daily report ${r.reportDate} emailed to ${i.to}` });
      return { applied: true };
    }
    case 'punch': {
      logActivity(db, { projectId: i.itemId, userId: i.userId, type: 'punch_sent', message: `Punch list report emailed to ${i.to}` });
      return { applied: true };
    }
    case 'payApp': {
      const row = db.prepare('SELECT projectId FROM aia_pay_apps WHERE id = ?').get(i.itemId) as { projectId: string } | undefined;
      if (!row) return { applied: false, skipped: 'missing' };
      logActivity(db, { projectId: row.projectId, userId: i.userId, type: 'payapp_sent', message: `Pay application emailed to ${i.to}` });
      return { applied: true };
    }
    default: return { applied: false, skipped: 'noop' };
  }
}
```

The proposal branch must keep the `markSent` argument shape used at `server/routes.ts:1758` (`{ to, cc, subject }`); pass `subject` from the caller by adding `subject?: string` to `SendEffectsInput` if `markSent` requires it.

- [ ] **Step 4: Run** → pass.
- [ ] **Step 5: Commit** — `git add server/mail/itemSendEffects.ts server/mail/itemSendEffects.test.ts && git commit -m "feat(mail): shared item send effects"`

---

### Task 11: Staged uploads + sendService

**Files:**
- Create: `server/mail/uploads.ts`, `server/mail/sendService.ts`
- Test: `server/mail/sendService.test.ts`, `server/mail/uploads.test.ts`

**Interfaces:**
- Consumes: accountStore, engine `upsertEnvelopes`, links, itemSendEffects, mime helpers, `getMeta`/`getDataUrlString` from `server/files.ts`, `readFileContent` from `server/fileStore.ts`.
- Produces:
  - `uploads.ts`: `stageUpload(dataDir, name: string, mime: string, buf: Buffer): { uploadId: string }`, `readUpload(dataDir, uploadId): { name; mime; buf } | null`, `discardUpload(dataDir, uploadId)`, `sweepUploads(dataDir, maxAgeMs = 3_600_000)`. Files under `data/tmp/mail-uploads/<uploadId>.bin` + `<uploadId>.json` meta.
  - `sendService.ts`: `send(ctx, user, req): Promise<SendResult>` (contract above) and `class MailSendError extends Error { status: number }` (400 no account / bad request, 409 no active account).

- [ ] **Step 1: Write the failing tests**

```ts
// server/mail/uploads.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { stageUpload, readUpload, discardUpload, sweepUploads } from './uploads';
describe('uploads', () => {
  it('stages, reads, discards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-up-'));
    const { uploadId } = stageUpload(dir, 'a.pdf', 'application/pdf', Buffer.from('x'));
    expect(readUpload(dir, uploadId)).toMatchObject({ name: 'a.pdf', mime: 'application/pdf' });
    discardUpload(dir, uploadId); expect(readUpload(dir, uploadId)).toBeNull();
  });
  it('sweep removes old files only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-up-'));
    const { uploadId } = stageUpload(dir, 'a', 'x', Buffer.from('x'));
    sweepUploads(dir, 60_000); expect(readUpload(dir, uploadId)).not.toBeNull();
    sweepUploads(dir, -1); expect(readUpload(dir, uploadId)).toBeNull();
  });
});
```

```ts
// server/mail/sendService.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db'; import { runMigrations } from '../migrations'; import { migrations } from '../migrationList';
import { createProject } from '../projectStore'; import { createRfi, getRfi } from '../rfiStore';
import { putBuffer } from '../files';
import { MailCrypto } from './crypto'; import * as accounts from './accountStore';
import { FakeMailProvider } from './providers/fake';
import type { MailContext } from './context';
import { send, MailSendError } from './sendService';
import { stageUpload } from './uploads';
import { listLinksForThread } from './links';

let db: Database.Database; let ctx: MailContext; let provider: FakeMailProvider; let dir: string; let acct: accounts.MailAccountRow;
const crypto = new MailCrypto(Buffer.alloc(32, 5)); const user = { id: 'u1', role: 'user' };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ss-')); db = openDb(':memory:'); runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role, createdAt) VALUES ('u1','a','x','user',1)`).run();
  createProject(db, { id: 'p1', name: 'P', createdAt: 1, pages: [], takeoffs: [] } as any);
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@bb.com', displayName: 'Me', auth: { refreshToken: 'r' } });
  provider = new FakeMailProvider(); provider.seed([]);
  ctx = { db, dataDir: dir, crypto, providerFactory: () => provider, broadcastChange: () => {} };
});
describe('sendService.send', () => {
  it('sends through the default account, indexes the sent row, links + effects the item', async () => {
    const { id: rfiId } = createRfi(db, 'p1', { title: 'Ceilings' });
    putBuffer(db, dir, 'f1', Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'rfi', name: 'RFI-001.pdf' });
    const r = await send(ctx, user, { to: [{ addr: 'gc@teg.com' }], subject: 'RFI-001', html: '<p>See attached</p>', attachments: [{ fileId: 'f1', itemType: 'rfi', itemId: rfiId }] });
    expect(provider.sent.length).toBe(1);
    expect(provider.sent[0]).toMatchObject({ from: { addr: 'me@bb.com', name: 'Me' }, subject: 'RFI-001', text: 'See attached' });
    expect(provider.sent[0].attachments[0]).toMatchObject({ name: 'RFI-001.pdf', mime: 'application/pdf' });
    const row = db.prepare('SELECT threadKey, sentFromApp, isRead FROM mail_messages').get() as any;
    expect(row.sentFromApp).toBe(1); expect(row.threadKey).toBe(r.threadKey);
    expect(listLinksForThread(db, r.threadKey).map(l => l.itemType)).toEqual(['rfi']);
    expect(getRfi(db, rfiId).status).toBe('sent');
    expect(db.prepare('SELECT lastOutboundDate FROM mail_thread_reply_state WHERE threadKey = ?').get(r.threadKey)).toBeTruthy();
    expect(r.effectsSkipped).toEqual([]);
  });
  it('replies inside an existing thread with In-Reply-To/References to its last message', async () => {
    db.prepare(`INSERT INTO mail_messages (id, accountId, providerMessageId, messageIdHeader, threadKey, date, createdAt, updatedAt, referencesJson) VALUES ('m1', ?, 'p1', 'root@teg.com', 'root@teg.com', '2026-08-01T00:00:00.000Z', 't', 't', '[]')`).run(acct.id);
    const r = await send(ctx, user, { to: [{ addr: 'gc@teg.com' }], subject: 'Re: x', html: 'ok', attachments: [], replyTo: { accountId: acct.id, threadKey: 'root@teg.com' } });
    expect(provider.sent[0].inReplyTo).toBe('root@teg.com'); expect(provider.sent[0].references).toEqual(['root@teg.com']);
    expect(r.threadKey).toBe('root@teg.com');
  });
  it('reports effectsSkipped for admin-gated items sent by a non-admin, still links', async () => {
    putBuffer(db, dir, 'f2', Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'invoice', name: 'Invoice-1.pdf' });
    const r = await send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [{ fileId: 'f2', itemType: 'invoice', itemId: 'inv1' }] });
    expect(r.effectsSkipped).toEqual(['invoice']);
    expect(listLinksForThread(db, r.threadKey).length).toBe(1);
  });
  it('uses staged uploads and deletes the draft after send', async () => {
    const { uploadId } = stageUpload(dir, 'site.jpg', 'image/jpeg', Buffer.from('jpg'));
    const d = await provider.saveDraft({ from: { addr: 'me@bb.com' }, to: [], cc: [], bcc: [], subject: '', html: '', text: '', attachments: [], messageIdHeader: 'x' });
    await send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [{ uploadId }], draftProviderId: d.providerMessageId });
    expect(provider.sent[0].attachments[0].name).toBe('site.jpg'); expect(provider.drafts.size).toBe(0);
    expect(fs.existsSync(path.join(dir, 'tmp', 'mail-uploads', uploadId + '.bin'))).toBe(false);
  });
  it('fails cleanly with no account / inactive account', async () => {
    accounts.updateAccount(db, acct.id, { status: 'auth_error' });
    await expect(send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [] })).rejects.toBeInstanceOf(MailSendError);
    accounts.deleteAccount(db, acct.id);
    await expect(send(ctx, user, { to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [] })).rejects.toThrow(/no mail account/i);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// server/mail/uploads.ts
import fs from 'fs'; import path from 'path';
import { v4 as uuidv4 } from 'uuid';
const dirOf = (dataDir: string) => path.join(dataDir, 'tmp', 'mail-uploads');
export function stageUpload(dataDir: string, name: string, mime: string, buf: Buffer): { uploadId: string } {
  const d = dirOf(dataDir); fs.mkdirSync(d, { recursive: true });
  const uploadId = uuidv4();
  fs.writeFileSync(path.join(d, uploadId + '.bin'), buf);
  fs.writeFileSync(path.join(d, uploadId + '.json'), JSON.stringify({ name, mime }));
  return { uploadId };
}
export function readUpload(dataDir: string, uploadId: string): { name: string; mime: string; buf: Buffer } | null {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) return null;
  const d = dirOf(dataDir); const bin = path.join(d, uploadId + '.bin'); const meta = path.join(d, uploadId + '.json');
  if (!fs.existsSync(bin) || !fs.existsSync(meta)) return null;
  const { name, mime } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return { name, mime, buf: fs.readFileSync(bin) };
}
export function discardUpload(dataDir: string, uploadId: string): void {
  const d = dirOf(dataDir); for (const ext of ['.bin', '.json']) { try { fs.unlinkSync(path.join(d, uploadId + ext)); } catch { /* gone */ } }
}
export function sweepUploads(dataDir: string, maxAgeMs = 3_600_000): void {
  const d = dirOf(dataDir); if (!fs.existsSync(d)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const f of fs.readdirSync(d)) { const p = path.join(d, f); try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ } }
}
```

```ts
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
```

- [ ] **Step 4: Run** → `npx vitest run --project server server/mail/uploads.test.ts server/mail/sendService.test.ts` → pass.
- [ ] **Step 5: Commit** — `git add server/mail/uploads.ts server/mail/uploads.test.ts server/mail/sendService.ts server/mail/sendService.test.ts && git commit -m "feat(mail): sendService — one outbound path with links, effects, staged uploads"`

---
### Task 12: `/api/mail/*` routes

**Files:**
- Create: `server/mail/routes.ts`
- Test: `server/mail/routes.test.ts`

**Interfaces:**
- Produces: `registerMailRoutes(app: express.Express, deps: MailRouteDeps)` with
  ```ts
  export interface MailRouteDeps { ctx: MailContext; authenticateToken: express.RequestHandler; requireAdmin: express.RequestHandler; verifyToken: (token: string) => { id: string; role: string } | null; bodyCache: BodyCache<BodyPayload>; publicUrl: string | null; env: NodeJS.ProcessEnv }
  export interface BodyPayload { html: string; text: string; blockedRemoteImages: number; attachments: AttachmentMeta[] }
  ```
  and a helper `authOrQueryToken(deps)` middleware: accepts `Authorization: Bearer` OR `?token=` (mirrors `server/routes.ts:1045` file-content route) for the attachment stream route.
- Routes (§4.4, all under `/api/mail`): see the table in the spec. OAuth start/callback and `/ms/webhook` are **Plan 2**; register only a `501 { error: 'oauth not configured' }` placeholder for `GET /api/mail/oauth/:provider/start` here so the client can show the disabled state from `GET /api/mail/setup-info`.
- Thread list row shape (client contract):
  ```ts
  interface ThreadListRow { threadKey; subject; firstDate; lastDate; messageCount; unreadCount; hasAttachments; isStarred; participants: Addr[]; folderIds: string[]; snippet: string; links: Array<{ id; itemType; itemId; projectId; customerId }> }
  ```
  Thread detail: `{ thread: ThreadListRow; messages: MessageRow[] }` where `MessageRow` = `mail_messages` columns with JSON fields parsed (`to`, `cc`, `bcc`, `references`, `attachments`, `folderIds`) and no provider ids exposed except `id`.

- [ ] **Step 1: Write the failing tests** (supertest, fake provider, two users)

```ts
// server/mail/routes.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express'; import request from 'supertest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db'; import { runMigrations } from '../migrations'; import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { MailCrypto } from './crypto'; import * as accounts from './accountStore';
import { FakeMailProvider } from './providers/fake'; import { getFakeProvider, resetFakes } from './providers/fakeRegistry';
import { registerMailRoutes } from './routes'; import { BodyCache } from './sync/bodyCache';
import { MailScheduler } from './sync/scheduler';
import { upsertFolders, upsertEnvelopes } from './sync/engine';
import type { MailContext } from './context';

let db: Database.Database; let dir: string; let app: express.Express; let ctx: MailContext; let acct: accounts.MailAccountRow; let provider: FakeMailProvider;
const crypto = new MailCrypto(Buffer.alloc(32, 6));
let currentUser = { id: 'u1', role: 'admin' };
const env = (id: string, o: any = {}) => ({ providerMessageId: id, references: [], from: { addr: 'gc@teg.com', name: 'Mike' }, to: [{ addr: 'me@bb.com' }], cc: [], bcc: [], subject: 'CO 4', snippet: 'hello', date: '2026-08-10T10:00:00.000Z',
  isRead: false, isStarred: false, isDraft: false, attachments: [{ attId: 'a1', name: 'cor.pdf', mime: 'application/pdf', size: 4 }], sizeBytes: 10, folderProviderIds: ['INBOX'], messageIdHeader: id + '@teg.com', html: '<p>Hi <img src="https://x/y.png"></p>', attachmentBytes: { a1: Buffer.from('%PDF') }, ...o });

beforeEach(async () => {
  resetFakes(); currentUser = { id: 'u1', role: 'admin' };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mr-')); db = openDb(':memory:'); runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role, createdAt) VALUES ('u1','a','x','admin',1), ('u2','b','x','user',1)`).run();
  createProject(db, { id: 'p1', name: 'P', createdAt: 1, pages: [], takeoffs: [] } as any);
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@bb.com', auth: { refreshToken: 'r' } });
  provider = getFakeProvider(acct.id); provider.seed([env('m1')]);
  ctx = { db, dataDir: dir, crypto, providerFactory: a => getFakeProvider(a.id), broadcastChange: () => {} };
  ctx.scheduler = new MailScheduler(ctx);
  upsertFolders(db, acct.id, provider.folders); upsertEnvelopes(ctx, acct, [env('m1')]);
  app = express(); app.use(express.json({ limit: '50mb' }));
  registerMailRoutes(app, { ctx, authenticateToken: (req: any, _r, next) => { req.user = currentUser; next(); }, requireAdmin: (req: any, res, next) => req.user.role === 'admin' ? next() : res.status(403).end(),
    verifyToken: t => (t === 'tok' ? currentUser : null), bodyCache: new BodyCache({ maxBytes: 1e6, ttlMs: 1e5 }), publicUrl: 'https://app.test', env: {} });
});

describe('mail routes', () => {
  it('GET /api/mail/accounts lists own accounts without secrets', async () => {
    const r = await request(app).get('/api/mail/accounts'); expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ id: acct.id, emailAddress: 'me@bb.com', isDefault: 1 }); expect(r.body[0].authBlob).toBeUndefined();
    currentUser = { id: 'u2', role: 'user' }; expect((await request(app).get('/api/mail/accounts')).body).toEqual([]);
  });
  it('POST /api/mail/accounts/imap creates a needs_review→ok account after test', async () => {
    const r = await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com', displayName: 'N', imapHost: 'imap.x', imapPort: 993, imapSecure: true, smtpHost: 'smtp.x', smtpPort: 587, smtpSecure: false, username: 'n', password: 'p' });
    expect(r.status).toBe(200); expect(r.body.provider).toBe('imap');
    const t = await request(app).post(`/api/mail/accounts/${r.body.id}/test`); expect(t.status).toBe(200);   // fake factory → always passes
    expect(accounts.getAccountAny(db, r.body.id)!.status).toBe('ok');
  });
  it('threads list + detail, scoped by owner', async () => {
    const folders = (await request(app).get('/api/mail/folders').query({ accountId: acct.id })).body;
    const inbox = folders.find((f: any) => f.role === 'inbox');
    const list = await request(app).get('/api/mail/threads').query({ accountId: acct.id, folderId: inbox.id });
    expect(list.status).toBe(200); expect(list.body.threads.length).toBe(1); expect(list.body.threads[0]).toMatchObject({ threadKey: 'm1@teg.com', unreadCount: 1, hasAttachments: 1 });
    const detail = await request(app).get(`/api/mail/threads/${acct.id}/${encodeURIComponent('m1@teg.com')}`);
    expect(detail.body.messages[0]).toMatchObject({ subject: 'CO 4', from: { addr: 'gc@teg.com' } }); expect(detail.body.messages[0].providerMessageId).toBeUndefined();
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id })).status).toBe(404);
  });
  it('search filters by subject/from/snippet', async () => {
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, q: 'mike' })).body.threads.length).toBe(1);
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, q: 'zzz' })).body.threads.length).toBe(0);
  });
  it('body is sanitized with remote images blocked, cached, and images=1 allows them', async () => {
    const id = (db.prepare('SELECT id FROM mail_messages').get() as any).id;
    const r = await request(app).get(`/api/mail/messages/${id}/body`); expect(r.status).toBe(200);
    expect(r.body.blockedRemoteImages).toBe(1); expect(r.body.html).toContain('data-blocked-src');
    provider.failNextWith(new Error('should not be called — cached'));
    expect((await request(app).get(`/api/mail/messages/${id}/body`)).status).toBe(200);
    provider.failNextWith(new Error('x')); await provider.listFolders().catch(() => {});   // clear the pending failure
    expect((await request(app).get(`/api/mail/messages/${id}/body`).query({ images: 1 })).body.blockedRemoteImages).toBe(0);
  });
  it('attachment streams with token auth and content-disposition; save persists to Documents', async () => {
    const id = (db.prepare('SELECT id FROM mail_messages').get() as any).id;
    const r = await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' });
    expect(r.status).toBe(200); expect(r.headers['content-type']).toContain('application/pdf'); expect(r.headers['content-disposition']).toContain('cor.pdf');
    expect((await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'bad' })).status).toBe(401);
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1', name: 'COR-4 signed.pdf', kind: 'document', projectId: 'p1' }] });
    expect(s.status).toBe(200); expect(s.body.fileIds.length).toBe(1);
    const f = db.prepare('SELECT name, kind, projectId, sourceType, sourceId FROM files WHERE id = ?').get(s.body.fileIds[0]) as any;
    expect(f).toMatchObject({ name: 'COR-4 signed.pdf', kind: 'document', projectId: 'p1', sourceType: 'mailMessage', sourceId: id });
  });
  it('actions apply locally + to the provider and revert on provider failure', async () => {
    const id = (db.prepare('SELECT id FROM mail_messages').get() as any).id;
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'read' })).status).toBe(200);
    expect((db.prepare('SELECT isRead FROM mail_messages').get() as any).isRead).toBe(1);
    provider.failNextWith(new Error('down'));
    const r = await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'star' });
    expect(r.status).toBe(502); expect((db.prepare('SELECT isStarred FROM mail_messages').get() as any).isStarred).toBe(0);
    expect((await request(app).post('/api/mail/threads/actions').send({ accountId: acct.id, threadKeys: ['m1@teg.com'], action: 'archive' })).status).toBe(200);
    expect(JSON.parse((db.prepare('SELECT folderIdsJson FROM mail_messages').get() as any).folderIdsJson)).toEqual([(db.prepare(`SELECT id FROM mail_folders WHERE role='archive'`).get() as any).id]);
  });
  it('send + drafts + links + unread + recipients + heartbeat + setup-info', async () => {
    const s = await request(app).post('/api/mail/send').send({ to: [{ addr: 'gc@teg.com' }], subject: 'Hi', html: '<p>x</p>', attachments: [] });
    expect(s.status).toBe(200); expect(s.body.threadKey).toBeTruthy(); expect(provider.sent.length).toBe(1);
    const d = await request(app).post('/api/mail/drafts').send({ accountId: acct.id, to: [], subject: 'draft', html: '' }); expect(d.status).toBe(200); expect(d.body.draftId).toBeTruthy();
    expect((await request(app).put(`/api/mail/drafts/${d.body.draftId}`).send({ accountId: acct.id, to: [], subject: 'draft2', html: '' })).status).toBe(200);
    expect((await request(app).delete(`/api/mail/drafts/${d.body.draftId}`).query({ accountId: acct.id })).status).toBe(200);
    const l = await request(app).post('/api/mail/links').send({ threadKey: s.body.threadKey, itemType: 'project', itemId: 'p1' }); expect(l.status).toBe(200);
    expect((await request(app).get('/api/mail/links').query({ itemType: 'project', itemId: 'p1' })).body.length).toBe(1);
    expect((await request(app).delete(`/api/mail/links/${l.body.id}`)).status).toBe(200);
    expect((await request(app).get('/api/mail/unread-count')).body).toEqual({ total: 1, byAccount: { [acct.id]: 1 } });
    const rc = await request(app).get('/api/mail/recipients').query({ q: 'teg' }); expect(rc.body.some((x: any) => x.addr === 'gc@teg.com')).toBe(true);
    expect((await request(app).post('/api/mail/heartbeat').send({ accountIds: [acct.id] })).status).toBe(204);
    const si = await request(app).get('/api/mail/setup-info'); expect(si.body).toMatchObject({ google: { configured: false, redirectUri: 'https://app.test/api/mail/oauth/google/callback' } });
    currentUser = { id: 'u2', role: 'user' }; expect((await request(app).get('/api/mail/setup-info')).status).toBe(403);
  });
  it('staged uploads: POST /api/mail/uploads returns uploadId usable by send', async () => {
    const u = await request(app).post('/api/mail/uploads').query({ name: 'a.jpg' }).set('Content-Type', 'image/jpeg').send(Buffer.from('jpg'));
    expect(u.status).toBe(200);
    const s = await request(app).post('/api/mail/send').send({ to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [{ uploadId: u.body.uploadId }] });
    expect(s.status).toBe(200); expect(provider.sent[0].attachments[0].name).toBe('a.jpg');
  });
  it('load-older moves indexedSince back and PATCH/DELETE account work', async () => {
    const before = acct.indexedSince;
    expect((await request(app).post(`/api/mail/accounts/${acct.id}/load-older`).send({ months: 6 })).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)!.indexedSince < before).toBe(true);
    expect((await request(app).patch(`/api/mail/accounts/${acct.id}`).send({ signatureHtml: '<p>sig</p>', displayName: 'Nate' })).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)!.signatureHtml).toBe('<p>sig</p>');
    expect((await request(app).delete(`/api/mail/accounts/${acct.id}`)).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `server/mail/routes.ts`**

Structure (write it fully; key handlers shown):

```ts
// server/mail/routes.ts  (spec §4.4)
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { MailContext } from './context';
import * as accounts from './accountStore';
import { upsertFolders, upsertEnvelopes, rebuildThread, runBackfill } from './sync/engine';
import { sanitizeEmailHtml } from './sanitize';
import { htmlToText, snippetOf, newMessageIdHeader } from './mime';
import { send, MailSendError } from './sendService';
import { createLink, deleteLink, listLinksForItem, listLinksForThread, type ItemType } from './links';
import { stageUpload } from './uploads';
import { putBuffer } from '../files';
import { listCustomers } from '../customerStore';
import type { BodyCache } from './sync/bodyCache';
import type { AttachmentMeta, Addr } from './providers/types';
import { AuthExpiredError } from './providers/types';

export interface BodyPayload { html: string; text: string; blockedRemoteImages: number; attachments: AttachmentMeta[] }
export interface MailRouteDeps { ctx: MailContext; authenticateToken: express.RequestHandler; requireAdmin: express.RequestHandler; verifyToken: (token: string) => { id: string; role: string } | null; bodyCache: BodyCache<BodyPayload>; publicUrl: string | null; env: NodeJS.ProcessEnv }

const parseRow = (r: any) => ({ id: r.id, accountId: r.accountId, threadKey: r.threadKey, messageIdHeader: r.messageIdHeader, inReplyTo: r.inReplyTo, references: JSON.parse(r.referencesJson || '[]'),
  from: r.fromAddr ? { addr: r.fromAddr, name: r.fromName ?? undefined } : null, to: JSON.parse(r.toJson), cc: JSON.parse(r.ccJson), bcc: JSON.parse(r.bccJson), subject: r.subject, snippet: r.snippet, date: r.date,
  isRead: !!r.isRead, isStarred: !!r.isStarred, isDraft: !!r.isDraft, hasAttachments: !!r.hasAttachments, attachments: JSON.parse(r.attachmentsJson), sizeBytes: r.sizeBytes, folderIds: JSON.parse(r.folderIdsJson), sentFromApp: !!r.sentFromApp });

export function registerMailRoutes(app: express.Express, deps: MailRouteDeps): void {
  const { ctx, authenticateToken, requireAdmin } = deps; const { db } = ctx;
  const userOf = (req: any) => req.user as { id: string; role: string };
  const owned = (req: any, accountId: string) => accounts.getOwned(db, userOf(req).id, accountId);
  const providerFor = (accountId: string) => ctx.scheduler ? ctx.scheduler.getProvider(accountId) : ctx.providerFactory(accounts.getAccountAny(db, accountId)!, accounts.readAuth(db, ctx.crypto, accountId)!);
  const ownedMessage = (req: any, id: string) => db.prepare('SELECT m.* FROM mail_messages m JOIN mail_accounts a ON a.id = m.accountId WHERE m.id = ? AND a.userId = ?').get(id, userOf(req).id) as any | undefined;
  const authOrQueryToken: express.RequestHandler = (req: any, res, next) => {
    const t = typeof req.query.token === 'string' ? req.query.token : null;
    if (t) { const u = deps.verifyToken(t); if (!u) return res.status(401).json({ error: 'Invalid token' }); req.user = u; return next(); }
    return authenticateToken(req, res, next);
  };
  const fail = (res: express.Response, e: any, fallback: string) => {
    if (e instanceof MailSendError) return res.status(e.status).json({ error: e.message });
    if (e instanceof AuthExpiredError) return res.status(409).json({ error: 'Mail account needs to be reconnected', code: 'auth_error' });
    console.error(fallback, e); return res.status(502).json({ error: e?.message || fallback });
  };

  // ── accounts ──
  app.get('/api/mail/accounts', authenticateToken, (req, res) => {
    const rows = accounts.listAccounts(db, userOf(req).id).map(a => ({ ...a, unreadCount: (db.prepare('SELECT COALESCE(SUM(t.unreadCount),0) n FROM mail_threads t JOIN mail_folders f ON f.accountId = t.accountId AND f.role = \'inbox\' WHERE t.accountId = ? AND instr(t.folderIdsJson, f.id) > 0').get(a.id) as any).n }));
    res.json(rows);
  });
  app.post('/api/mail/accounts/imap', authenticateToken, (req, res) => {
    const b = req.body ?? {};
    for (const k of ['emailAddress', 'imapHost', 'smtpHost', 'username']) if (typeof b[k] !== 'string' || !b[k].trim()) return res.status(400).json({ error: `${k} is required` });
    const auth: accounts.ImapAuth = { imapHost: b.imapHost.trim(), imapPort: Number(b.imapPort) || 993, imapSecure: b.imapSecure !== false, smtpHost: b.smtpHost.trim(), smtpPort: Number(b.smtpPort) || 587, smtpSecure: !!b.smtpSecure, username: b.username.trim(), password: String(b.password ?? '') };
    if (typeof b.id === 'string') {
      const a = owned(req, b.id); if (!a) return res.status(404).json({ error: 'Account not found' });
      const prev = accounts.readAuth(db, ctx.crypto, a.id) as accounts.ImapAuth; if (!auth.password) auth.password = prev.password;
      accounts.updateAuth(db, ctx.crypto, a.id, auth); accounts.updateAccount(db, a.id, { emailAddress: b.emailAddress.trim().toLowerCase(), displayName: b.displayName ?? a.displayName, status: 'needs_review' });
      ctx.scheduler?.stopAccount(a.id); ctx.scheduler?.dropProvider(a.id);
      return res.json(accounts.getAccountAny(db, a.id));
    }
    if (!auth.password) return res.status(400).json({ error: 'password is required' });
    const a = accounts.createAccount(db, ctx.crypto, { userId: userOf(req).id, provider: deps.env.MAIL_FAKE_PROVIDER === '1' ? 'fake' : 'imap', emailAddress: b.emailAddress, displayName: b.displayName ?? null, auth, status: 'needs_review' });
    res.json(a);
  });
  app.post('/api/mail/accounts/:id/test', authenticateToken, async (req, res) => {
    const a = owned(req, req.params.id); if (!a) return res.status(404).json({ error: 'Account not found' });
    try {
      ctx.scheduler?.dropProvider(a.id);
      await providerFor(a.id).listFolders();
      accounts.updateAccount(db, a.id, { status: 'ok', lastError: null });
      ctx.scheduler?.startAccount(a.id);
      ctx.broadcastChange({ type: 'mailAccount', id: a.id, action: 'updated', byUserId: a.userId });
      res.json({ ok: true });
    } catch (e: any) { accounts.updateAccount(db, a.id, { lastError: e?.message || 'Connection failed' }); res.status(400).json({ error: e?.message || 'Connection failed' }); }
  });
  app.patch('/api/mail/accounts/:id', authenticateToken, (req, res) => {
    const a = owned(req, req.params.id); if (!a) return res.status(404).json({ error: 'Account not found' });
    const b = req.body ?? {}; const patch: any = {};
    if (typeof b.displayName === 'string') patch.displayName = b.displayName; if (typeof b.signatureHtml === 'string') patch.signatureHtml = b.signatureHtml;
    if (b.status === 'disabled') { patch.status = 'disabled'; ctx.scheduler?.stopAccount(a.id); } else if (b.status === 'ok' && a.status === 'disabled') { patch.status = 'ok'; ctx.scheduler?.startAccount(a.id); }
    accounts.updateAccount(db, a.id, patch);
    if (b.isDefault === true) accounts.setDefault(db, a.userId, a.id);
    res.json(accounts.getAccountAny(db, a.id));
  });
  app.delete('/api/mail/accounts/:id', authenticateToken, (req, res) => {
    const a = owned(req, req.params.id); if (!a) return res.status(404).json({ error: 'Account not found' });
    ctx.scheduler?.stopAccount(a.id); ctx.scheduler?.dropProvider(a.id); accounts.deleteAccount(db, a.id); res.json({ ok: true });
  });
  app.post('/api/mail/accounts/:id/load-older', authenticateToken, async (req, res) => {
    const a = owned(req, req.params.id); if (!a) return res.status(404).json({ error: 'Account not found' });
    const months = Math.min(60, Math.max(1, Number(req.body?.months) || 6));
    const newSince = new Date(new Date(a.indexedSince).getTime() - months * 30 * 86400000).toISOString();
    accounts.updateAccount(db, a.id, { indexedSince: newSince });
    res.json({ indexedSince: newSince });
    // Backfill only the newly opened window, in the background.
    runBackfill(ctx, accounts.getAccountAny(db, a.id)!, providerFor(a.id), new Date(newSince)).catch(e => console.error('[mail] load-older failed', e));
  });
  app.get('/api/mail/oauth/:provider/start', authenticateToken, (_req, res) => res.status(501).json({ error: 'OAuth providers are installed in the next phase' }));

  // ── folders / threads / messages ──
  app.get('/api/mail/folders', authenticateToken, (req, res) => {
    const a = owned(req, String(req.query.accountId)); if (!a) return res.status(404).json({ error: 'Account not found' });
    res.json(db.prepare('SELECT * FROM mail_folders WHERE accountId = ? ORDER BY sortOrder, name').all(a.id));
  });
  const linksFor = (keys: string[]) => { const out = new Map<string, any[]>(); if (!keys.length) return out;
    (db.prepare(`SELECT id, threadKey, itemType, itemId, projectId, customerId FROM mail_thread_links WHERE threadKey IN (${keys.map(() => '?').join(',')})`).all(...keys) as any[]).forEach(l => { const arr = out.get(l.threadKey) ?? []; arr.push(l); out.set(l.threadKey, arr); }); return out; };
  const threadRow = (t: any, links: Map<string, any[]>) => {
    const last = db.prepare('SELECT snippet FROM mail_messages WHERE accountId = ? AND threadKey = ? ORDER BY date DESC LIMIT 1').get(t.accountId, t.threadKey) as any;
    return { threadKey: t.threadKey, subject: t.subject, firstDate: t.firstDate, lastDate: t.lastDate, messageCount: t.messageCount, unreadCount: t.unreadCount, hasAttachments: t.hasAttachments, isStarred: t.isStarred,
      participants: JSON.parse(t.participantsJson), folderIds: JSON.parse(t.folderIdsJson), snippet: last?.snippet ?? '', links: links.get(t.threadKey) ?? [] };
  };
  app.get('/api/mail/threads', authenticateToken, (req, res) => {
    const a = owned(req, String(req.query.accountId)); if (!a) return res.status(404).json({ error: 'Account not found' });
    const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : null; const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const before = typeof req.query.before === 'string' ? req.query.before : null; const limit = Math.min(100, Number(req.query.limit) || 50);
    const where = ['t.accountId = ?']; const params: any[] = [a.id];
    if (folderId) { where.push('instr(t.folderIdsJson, ?) > 0'); params.push(`"${folderId}"`); }
    if (before) { where.push('t.lastDate < ?'); params.push(before); }
    if (q) { where.push(`EXISTS (SELECT 1 FROM mail_messages m WHERE m.accountId = t.accountId AND m.threadKey = t.threadKey AND (lower(m.subject) LIKE ? OR lower(m.fromAddr) LIKE ? OR lower(m.fromName) LIKE ? OR lower(m.snippet) LIKE ? OR lower(m.toJson) LIKE ?))`); params.push(...Array(5).fill(`%${q}%`)); }
    const rows = db.prepare(`SELECT * FROM mail_threads t WHERE ${where.join(' AND ')} ORDER BY t.lastDate DESC LIMIT ?`).all(...params, limit + 1) as any[];
    const hasMore = rows.length > limit; const page = rows.slice(0, limit);
    res.json({ threads: page.map(t => threadRow(t, linksFor(page.map(p => p.threadKey)))), hasMore, indexedSince: a.indexedSince });
  });
  app.get('/api/mail/threads/:accountId/:threadKey', authenticateToken, (req, res) => {
    const a = owned(req, req.params.accountId); if (!a) return res.status(404).json({ error: 'Account not found' });
    const t = db.prepare('SELECT * FROM mail_threads WHERE accountId = ? AND threadKey = ?').get(a.id, req.params.threadKey) as any; if (!t) return res.status(404).json({ error: 'Thread not found' });
    const messages = (db.prepare('SELECT * FROM mail_messages WHERE accountId = ? AND threadKey = ? ORDER BY date').all(a.id, t.threadKey) as any[]).map(parseRow);
    res.json({ thread: threadRow(t, linksFor([t.threadKey])), messages, links: listLinksForThread(db, t.threadKey) });
  });
  app.get('/api/mail/messages/:id/body', authenticateToken, async (req, res) => {
    const m = ownedMessage(req, req.params.id); if (!m) return res.status(404).json({ error: 'Message not found' });
    const allowImages = req.query.images === '1'; const key = `${m.id}:${allowImages ? 1 : 0}`;
    const hit = deps.bodyCache.get(key); if (hit) return res.json(hit);
    try {
      const raw = await providerFor(m.accountId).getBody(m.providerMessageId);
      const attachmentUrl = (cid: string) => { const att = raw.attachments.find(x => (x.contentId || '').replace(/^<|>$/g, '') === cid); return att ? `/api/mail/messages/${m.id}/attachments/${encodeURIComponent(att.attId)}?inline=1` : null; };
      const html = raw.html ? sanitizeEmailHtml(raw.html, { attachmentUrl, allowRemoteImages: allowImages }) : { html: `<pre style="white-space:pre-wrap;font-family:inherit">${(raw.text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))}</pre>`, blockedRemoteImages: 0 };
      const payload: BodyPayload = { html: html.html, text: raw.text ?? htmlToText(raw.html ?? ''), blockedRemoteImages: html.blockedRemoteImages, attachments: raw.attachments };
      deps.bodyCache.set(key, payload, payload.html.length + payload.text.length);
      res.json(payload);
    } catch (e) { fail(res, e, 'Failed to load message'); }
  });
  app.get('/api/mail/messages/:id/attachments/:attId', authOrQueryToken, async (req, res) => {
    const m = ownedMessage(req, req.params.id); if (!m) return res.status(404).json({ error: 'Message not found' });
    try {
      const att = await providerFor(m.accountId).getAttachment(m.providerMessageId, req.params.attId);
      res.setHeader('Content-Type', att.mime || 'application/octet-stream'); res.setHeader('X-Content-Type-Options', 'nosniff');
      if (att.size) res.setHeader('Content-Length', String(att.size));
      res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${att.name.replace(/["\r\n]/g, '')}"`);
      att.stream.pipe(res);
    } catch (e) { fail(res, e, 'Failed to load attachment'); }
  });
  app.post('/api/mail/messages/:id/attachments/save', authenticateToken, async (req, res) => {
    const m = ownedMessage(req, req.params.id); if (!m) return res.status(404).json({ error: 'Message not found' });
    const items = Array.isArray(req.body?.items) ? req.body.items : []; if (!items.length) return res.status(400).json({ error: 'items required' });
    const metas: AttachmentMeta[] = JSON.parse(m.attachmentsJson); const fileIds: string[] = [];
    try {
      for (const it of items) {
        const meta = metas.find(x => x.attId === it.attId); if (!meta) continue;
        const att = await providerFor(m.accountId).getAttachment(m.providerMessageId, it.attId);
        const chunks: Buffer[] = []; let total = 0;
        for await (const c of att.stream as AsyncIterable<Buffer>) { total += c.length; if (total > 100 * 1024 * 1024) throw new MailSendError('Attachment exceeds 100 MB', 413); chunks.push(c); }
        const r = putBuffer(db, ctx.dataDir, uuidv4(), Buffer.concat(chunks), att.mime, { projectId: it.projectId || undefined, customerId: it.customerId || undefined, kind: typeof it.kind === 'string' ? it.kind : 'document', name: it.name || meta.name, sourceType: 'mailMessage', sourceId: m.id });
        fileIds.push(r.id); ctx.broadcastChange({ type: 'file', id: r.id, projectId: it.projectId || undefined, action: 'created', byUserId: userOf(req).id });
      }
      res.json({ fileIds });
    } catch (e) { fail(res, e, 'Failed to save attachment'); }
  });

  // ── actions (optimistic local, provider, revert) ──
  type Action = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'trash' | 'move';
  async function applyAction(req: any, rows: any[], action: Action, folderId?: string): Promise<void> {
    if (!rows.length) return;
    const byAccount = new Map<string, any[]>(); rows.forEach(r => byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]));
    for (const [accountId, list] of byAccount) {
      const snapshot = list.map(r => ({ id: r.id, isRead: r.isRead, isStarred: r.isStarred, folderIdsJson: r.folderIdsJson }));
      const roleFolder = (role: string) => db.prepare('SELECT id, providerId FROM mail_folders WHERE accountId = ? AND role = ?').get(accountId, role) as { id: string; providerId: string } | undefined;
      const target = action === 'archive' ? roleFolder('archive') : action === 'trash' ? roleFolder('trash') : action === 'move' ? (db.prepare('SELECT id, providerId FROM mail_folders WHERE id = ? AND accountId = ?').get(folderId, accountId) as any) : null;
      if ((action === 'archive' || action === 'trash' || action === 'move') && !target) throw new MailSendError('Folder not found', 400);
      const local = db.transaction(() => { for (const r of list) {
        if (action === 'read' || action === 'unread') db.prepare('UPDATE mail_messages SET isRead = ? WHERE id = ?').run(action === 'read' ? 1 : 0, r.id);
        else if (action === 'star' || action === 'unstar') db.prepare('UPDATE mail_messages SET isStarred = ? WHERE id = ?').run(action === 'star' ? 1 : 0, r.id);
        else db.prepare('UPDATE mail_messages SET folderIdsJson = ? WHERE id = ?').run(JSON.stringify([target!.id]), r.id);
      } for (const k of new Set(list.map(r => r.threadKey))) rebuildThread(db, accountId, k); });
      local();
      try {
        const p = providerFor(accountId); const ids = list.map(r => r.providerMessageId);
        if (action === 'read' || action === 'unread') await p.setFlags(ids, { read: action === 'read' });
        else if (action === 'star' || action === 'unstar') await p.setFlags(ids, { starred: action === 'star' });
        else if (action === 'archive') await p.archive(ids); else if (action === 'trash') await p.trash(ids); else await p.move(ids, target!.providerId);
      } catch (e) {
        db.transaction(() => { for (const s of snapshot) db.prepare('UPDATE mail_messages SET isRead = ?, isStarred = ?, folderIdsJson = ? WHERE id = ?').run(s.isRead, s.isStarred, s.folderIdsJson, s.id); for (const k of new Set(list.map(r => r.threadKey))) rebuildThread(db, accountId, k); })();
        throw e;
      } finally { for (const k of new Set(list.map(r => r.threadKey))) ctx.broadcastChange({ type: 'mailThread', id: k, action: 'updated', byUserId: userOf(req).id }); }
    }
  }
  app.post('/api/mail/messages/actions', authenticateToken, async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : []; const rows = ids.map(id => ownedMessage(req, id)).filter(Boolean);
    try { await applyAction(req, rows, req.body?.action, req.body?.folderId); res.json({ ok: true }); } catch (e) { fail(res, e, 'Action failed'); }
  });
  app.post('/api/mail/threads/actions', authenticateToken, async (req, res) => {
    const a = owned(req, String(req.body?.accountId)); if (!a) return res.status(404).json({ error: 'Account not found' });
    const keys: string[] = Array.isArray(req.body?.threadKeys) ? req.body.threadKeys : [];
    const rows = keys.length ? db.prepare(`SELECT * FROM mail_messages WHERE accountId = ? AND threadKey IN (${keys.map(() => '?').join(',')})`).all(a.id, ...keys) as any[] : [];
    try { await applyAction(req, rows, req.body?.action, req.body?.folderId); res.json({ ok: true }); } catch (e) { fail(res, e, 'Action failed'); }
  });

  // ── send / drafts / uploads ──
  app.post('/api/mail/send', authenticateToken, async (req, res) => { try { res.json(await send(ctx, userOf(req), req.body)); } catch (e) { fail(res, e, 'Send failed'); } });
  const draftMsg = (a: accounts.MailAccountRow, b: any) => ({ from: { addr: a.emailAddress, name: a.displayName ?? undefined }, to: b.to ?? [], cc: b.cc ?? [], bcc: b.bcc ?? [], subject: b.subject ?? '', html: b.html ?? '', text: htmlToText(b.html ?? ''), attachments: [], messageIdHeader: newMessageIdHeader(a.emailAddress.split('@')[1] || 'localhost') });
  app.post('/api/mail/drafts', authenticateToken, async (req, res) => { const a = owned(req, String(req.body?.accountId)); if (!a) return res.status(404).json({ error: 'Account not found' });
    try { const r = await providerFor(a.id).saveDraft(draftMsg(a, req.body)); res.json({ draftId: r.providerMessageId }); } catch (e) { fail(res, e, 'Draft save failed'); } });
  app.put('/api/mail/drafts/:id', authenticateToken, async (req, res) => { const a = owned(req, String(req.body?.accountId)); if (!a) return res.status(404).json({ error: 'Account not found' });
    try { const r = await providerFor(a.id).saveDraft(draftMsg(a, req.body), req.params.id); res.json({ draftId: r.providerMessageId }); } catch (e) { fail(res, e, 'Draft save failed'); } });
  app.delete('/api/mail/drafts/:id', authenticateToken, async (req, res) => { const a = owned(req, String(req.query.accountId)); if (!a) return res.status(404).json({ error: 'Account not found' });
    try { await providerFor(a.id).deleteDraft(req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e, 'Draft delete failed'); } });
  app.post('/api/mail/uploads', authenticateToken, express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
    const name = typeof req.query.name === 'string' && req.query.name ? req.query.name : 'attachment';
    const { uploadId } = stageUpload(ctx.dataDir, name, req.get('content-type') || 'application/octet-stream', req.body as Buffer);
    res.json({ uploadId });
  });
  app.get('/api/mail/search', authenticateToken, async (req, res) => {
    const a = owned(req, String(req.query.accountId)); if (!a) return res.status(404).json({ error: 'Account not found' });
    try { const hits = await providerFor(a.id).search(String(req.query.q || ''), { before: typeof req.query.before === 'string' ? new Date(req.query.before) : new Date(a.indexedSince), limit: 50 });
      upsertEnvelopes(ctx, a, hits); res.json({ count: hits.length }); } catch (e) { fail(res, e, 'Search failed'); }
  });

  // ── misc ──
  app.get('/api/mail/recipients', authenticateToken, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase(); const out: Array<Addr & { source: string; customerId?: string; role?: string }> = [];
    for (const c of listCustomers(db)) { const emails = (c as any).emails ?? {}; for (const role of ['general', 'accounting', 'estimating', 'pm']) { for (const field of ['to', 'cc']) { const raw: string = emails?.[role]?.[field] ?? ''; raw.split(/[,;]/).map(s => s.trim()).filter(Boolean).forEach(addr => { if (!q || addr.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) out.push({ addr: addr.toLowerCase(), name: c.contactName || c.name, source: `${c.name} · ${role}`, customerId: c.id, role }); }); } } }
    const recent = db.prepare(`SELECT DISTINCT m.fromAddr addr, m.fromName name FROM mail_messages m JOIN mail_accounts a ON a.id = m.accountId WHERE a.userId = ? AND m.fromAddr IS NOT NULL AND (lower(m.fromAddr) LIKE ? OR lower(m.fromName) LIKE ?) ORDER BY m.date DESC LIMIT 20`).all(userOf(req).id, `%${q}%`, `%${q}%`) as any[];
    recent.forEach(r => { if (!out.some(o => o.addr === r.addr)) out.push({ addr: r.addr, name: r.name ?? undefined, source: 'recent' }); });
    res.json(out.slice(0, 25));
  });
  app.get('/api/mail/unread-count', authenticateToken, (req, res) => {
    const rows = db.prepare(`SELECT t.accountId, SUM(t.unreadCount) n FROM mail_threads t JOIN mail_accounts a ON a.id = t.accountId JOIN mail_folders f ON f.accountId = t.accountId AND f.role = 'inbox' WHERE a.userId = ? AND instr(t.folderIdsJson, f.id) > 0 GROUP BY t.accountId`).all(userOf(req).id) as any[];
    const byAccount: Record<string, number> = {}; let total = 0; rows.forEach(r => { byAccount[r.accountId] = r.n; total += r.n; }); res.json({ total, byAccount });
  });
  app.post('/api/mail/heartbeat', authenticateToken, (req, res) => { const ids: string[] = Array.isArray(req.body?.accountIds) ? req.body.accountIds : []; ctx.scheduler?.markViewed(ids.filter(id => owned(req, id))); res.status(204).end(); });
  app.get('/api/mail/links', authenticateToken, (req, res) => res.json(listLinksForItem(db, req.query.itemType as ItemType, String(req.query.itemId))));
  app.post('/api/mail/links', authenticateToken, (req, res) => { const b = req.body ?? {}; if (!b.threadKey || !b.itemType || !b.itemId) return res.status(400).json({ error: 'threadKey, itemType, itemId required' });
    const t = db.prepare('SELECT t.* FROM mail_threads t JOIN mail_accounts a ON a.id = t.accountId WHERE t.threadKey = ? AND a.userId = ? LIMIT 1').get(b.threadKey, userOf(req).id) as any;
    res.json(createLink(db, { threadKey: b.threadKey, itemType: b.itemType, itemId: b.itemId, linkedByUserId: userOf(req).id, subjectSnapshot: t?.subject ?? null, firstDate: t?.firstDate ?? null, participants: t ? JSON.parse(t.participantsJson) : [] })); });
  app.delete('/api/mail/links/:id', authenticateToken, (req, res) => { deleteLink(db, req.params.id); res.json({ ok: true }); });
  app.get('/api/mail/setup-info', authenticateToken, requireAdmin, (_req, res) => {
    const base = deps.publicUrl?.replace(/\/$/, '') ?? null;
    res.json({ publicUrl: base, google: { configured: !!(deps.env.GOOGLE_OAUTH_CLIENT_ID && deps.env.GOOGLE_OAUTH_CLIENT_SECRET), redirectUri: base ? `${base}/api/mail/oauth/google/callback` : null },
      microsoft: { configured: !!(deps.env.MS_OAUTH_CLIENT_ID && deps.env.MS_OAUTH_CLIENT_SECRET), redirectUri: base ? `${base}/api/mail/oauth/microsoft/callback` : null, webhookUrl: base ? `${base}/api/mail/ms/webhook` : null, tenant: deps.env.MS_OAUTH_TENANT || 'common' },
      secretKey: deps.env.MAIL_SECRET_KEY ? 'env' : 'file' });
  });
}
```

Note the `folderIdsJson` filter uses `instr(t.folderIdsJson, '"<id>"')` — ids are uuids inside a JSON array so a quoted match is exact.

- [ ] **Step 4: Run** → `npx vitest run --project server server/mail/routes.test.ts` → all pass. Then `npm run lint`.

- [ ] **Step 5: Commit** — `git add server/mail/routes.ts server/mail/routes.test.ts && git commit -m "feat(mail): /api/mail routes — accounts, folders, threads, bodies, attachments, actions, send, drafts, links"`

---

### Task 13: Rewire item send routes; remove SMTP plumbing; wire `server.ts`

**Files:**
- Modify: `server/routes.ts:1590-1935` (`EmailRouteDeps`, delete `sendProjectEmail`, SMTP config/test routes; rewrite 7 send routes), `server/routes.test.ts` (email-route tests), `server.ts:565-600` (remove `getUserSmtp`/`buildTransporter`; add mail wiring), `server.ts:174-180` (shutdown), `src/utils/store.ts:336-360` (delete `getSmtpSettings/saveSmtpSettings/testSmtpConnection`), `src/types.ts:170` (`SmtpSettings` — delete), `src/pages/Settings.tsx:934-1110` (EmailTab SMTP card → temporary "moved to Mail" notice; Plan 3 replaces the tab), `src/pages/project/rfi/RfiEditor.tsx:3` and any other importer of `getSmtpSettings` (`grep -rn getSmtpSettings src`).

**Interfaces:**
- New `EmailRouteDeps`: `{ db, dataDir, authenticateToken, requireAdmin, broadcastChange, mailCtx: MailContext }`.
- Each item route body is unchanged in shape (`SendBody`) **plus** optional `replyTo?: { accountId; threadKey }`, `accountId?`, and `html?` (rich body; `body`/`message` still accepted as plain text → wrapped in `<p>` with escaped line breaks). Response: `{ success: true, messageId, threadKey, accountId, effectsSkipped, ...routeSpecific }`.

- [ ] **Step 1: Update the tests first**

In `server/routes.test.ts` find the `describe` block(s) that build `registerEmailRoutes` with a stubbed `buildTransporter` (grep `buildTransporter`). Replace the stub deps with a `mailCtx` using `FakeMailProvider` via `getFakeProvider`, an account for `u1`, and assert on `provider.sent` instead of the transporter mock. Add:

```ts
it('POST /api/rfis/:id/send sends via the mail account, links the thread, marks sent', async () => {
  const { id } = createRfi(db, 'p1', { title: 'Ceilings' });
  putBuffer(db, dir, 'f-rfi', Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'rfi', name: 'RFI-001' });
  const r = await request(app).post(`/api/rfis/${id}/send`).send({ to: 'gc@teg.com', fileId: 'f-rfi', subject: 'RFI-001', body: 'See attached' });
  expect(r.status).toBe(200); expect(r.body.threadKey).toBeTruthy();
  expect(provider.sent[0].attachments[0].name).toBe('RFI-001.pdf');
  expect(getRfi(db, id).status).toBe('sent');
  expect(db.prepare('SELECT itemType FROM mail_thread_links WHERE threadKey = ?').all(r.body.threadKey)).toEqual([{ itemType: 'rfi' }]);
});
it('POST /api/rfis/:id/send with no mail account → 409', async () => {
  accounts.deleteAccount(db, acct.id);
  const { id } = createRfi(db, 'p1', { title: 'x' });
  expect((await request(app).post(`/api/rfis/${id}/send`).send({ to: 'a@b', fileId: 'f' })).status).toBe(409);
});
```

Keep every existing assertion about side effects (proposal locked → 409, invoice not demoted from paid, etc.) — only the transport changes.

- [ ] **Step 2: Run** → FAIL (old deps shape).

- [ ] **Step 3: Rewrite `registerEmailRoutes`**

Delete `sendProjectEmail`, the `nodemailer` import, `GET/POST /api/email/smtp`, `POST /api/email/test-smtp`. Keep `buildSendAttachments`, `withPdfExtension`, `SendBody`. New helper inside `registerEmailRoutes`:

```ts
import { send as mailSend, MailSendError } from './mail/sendService';
import type { ItemType } from './mail/links';
import { parseAddressList } from './mail/mime';

const textToHtml = (t: string) => `<p>${t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)).replace(/\n/g, '<br>')}</p>`;
const sendItem = async (req: any, res: express.Response, item: { itemType: ItemType; itemId: string; primaryName: string; defaultSubject: string; defaultBody: string; projectId: string }) => {
  const { to, fileId, message, cc, bcc, subject, body, html, attachmentFileIds, replyTo, accountId } = req.body as SendBody & { html?: string; replyTo?: { accountId: string; threadKey: string }; accountId?: string };
  if (!to || !fileId) { res.status(400).json({ error: 'to and fileId are required' }); return null; }
  const attachments = buildSendAttachments(db, { fileId, attachmentName: item.primaryName }, attachmentFileIds)
    .map((a, i) => ({ fileId: a.fileId, name: a.attachmentName, ...(i === 0 ? { itemType: item.itemType, itemId: item.itemId } : {}) }));
  try {
    return await mailSend(deps.mailCtx, req.user, { accountId, to: parseAddressList(to), cc: parseAddressList(cc || ''), bcc: parseAddressList(bcc || ''),
      subject: subject?.trim() || item.defaultSubject, html: html || textToHtml(body ?? message ?? item.defaultBody), attachments, replyTo, links: [{ itemType: item.itemType, itemId: item.itemId }] });
  } catch (e: any) {
    if (e instanceof MailSendError) res.status(e.status).json({ error: e.message }); else { console.error('send failed', e); res.status(502).json({ error: e?.message || 'Send failed' }); }
    return null;
  }
};
```

Then each route becomes: load item → validations that exist today (404, proposal locked 409) → `const r = await sendItem(req, res, {...}); if (!r) return;` → **no** status/activity code (it now runs inside `sendService` via `applySendEffects`, which also broadcasts) → `res.json({ success: true, ...r })`. Proposal: `markSent`'s return value used to feed `version` into the response — read `getProposal(db, p.id)` after send and include `version` for the client. The `inReplyTo: project?.email?.messageId` line is removed.

- [ ] **Step 4: Wire `server.ts`**

Replace lines 565-600 with:

```ts
  // ── Mail subsystem (spec 2026-08-29) ──
  const mailCrypto = loadMailCrypto(DATA_DIR);
  const mailCtx: MailContext = { db, dataDir: DATA_DIR, crypto: mailCrypto, providerFactory: createMailProvider, broadcastChange };
  const mailScheduler = new MailScheduler(mailCtx); mailCtx.scheduler = mailScheduler;
  registerMailRoutes(app, { ctx: mailCtx, authenticateToken, requireAdmin, verifyToken, bodyCache: new BodyCache({ maxBytes: 50 * 1024 * 1024, ttlMs: 10 * 60_000 }), publicUrl: process.env.APP_PUBLIC_URL || null, env: process.env });
  registerEmailRoutes(app, { db, dataDir: DATA_DIR, authenticateToken, requireAdmin, broadcastChange, mailCtx });
  mailScheduler.start();
  sweepUploads(DATA_DIR); setInterval(() => sweepUploads(DATA_DIR), 15 * 60_000).unref();
```

`createMailProvider` lives in `server/mail/providers/index.ts` (new, tiny): returns `getFakeProvider(account.id)` when `process.env.MAIL_FAKE_PROVIDER === '1' || account.provider === 'fake'`, otherwise throws `new Error('Provider ' + account.provider + ' not installed yet')` — Plan 2 fills it in. `verifyToken` is currently an inline lambda passed twice (`server.ts:157` and `:219`); extract it to `const verifyToken = (token: string) => {...}` once and pass the same const to realtime, data routes and mail routes.

`initDb()` (`server.ts:72`) must pass `mailCrypto: loadMailCrypto(DATA_DIR)` in the existing options object: `runMigrations(db, DATA_DIR, migrations, { dbFile: DB_FILE, vacuum: true, mailCrypto })` so the SMTP transform runs.

Shutdown: in `flushAndExit` (`server.ts:174`), `mailScheduler.stop()` before `sheetFlush.flushAll()` — the scheduler is declared later in the function, so hoist a `let mailScheduler: MailScheduler | undefined` above `flushAndExit` and `Promise.all([mailScheduler?.stop(), sheetFlush.flushAll()])`.

- [ ] **Step 5: Client fallout (minimal, keeps `npm run lint` green)**

- `src/utils/store.ts`: delete `getSmtpSettings`, `saveSmtpSettings`, `testSmtpConnection`; add
  ```ts
  export const getMailAccounts = async (): Promise<Array<{ id: string; provider: string; emailAddress: string; displayName: string | null; isDefault: number; status: string; unreadCount: number }>> => { const res = await fetch('/api/mail/accounts', { headers: getAuthHeaders() }); await handleResponse(res); return res.json(); };
  ```
- Every editor that called `getSmtpSettings()` to decide `send.blockedReason` (grep `getSmtpSettings` in `src/pages/project`) switches to `getMailAccounts()` and blocks with `'Connect a mail account in Settings → Mail'` when no account has `status === 'ok' || 'syncing'`.
- `src/pages/Settings.tsx` `EmailTab`: remove the SMTP card + its state; keep Always CC; add a one-line notice "Outbound email now uses your connected mail account (Settings → Mail, coming in the next update)". Plan 3 replaces this tab.
- `src/types.ts`: remove `SmtpSettings`.
- Tests: `src/pages/Settings.test.tsx` / any test mocking `getSmtpSettings` — update mocks to `getMailAccounts`.

- [ ] **Step 6: Run everything**

`npm run lint && npm test` → green. Then start the dev server with `MAIL_FAKE_PROVIDER=1 npm run dev`, log in, confirm `/api/mail/accounts` returns `[]` and no startup errors.

- [ ] **Step 7: Commit + push**

```bash
git add -A server server.ts src
git commit -m "feat(mail): item send routes go through sendService; SMTP settings retired; mail subsystem wired into server"
git push origin testing
```

---

## Plan 1 self-review notes

- Spec coverage: §3 tables ✔ (Task 2), §3.1 ✔ (4), §3.2 ✔ (2, 13), §4 modules ✔ (1–12 except providers/oauth/webhook/inboundHooks → Plans 2/4), §4.3 ✔ (12), §4.4 ✔ (12; OAuth/webhook stubbed), §4.5 ✔ (11), §4.6 ✔ (10), §7 crypto/ownership/sanitizer ✔, §9 unit+route ✔.
- Known intentional gap after Plan 1: real sending only works with `MAIL_FAKE_PROVIDER=1` until Plan 2 lands the IMAP/Google/Microsoft providers. Migrated SMTP accounts sit in `needs_review` and cannot be activated until Plan 2. Ship Plans 1+2 to `testing` together.
