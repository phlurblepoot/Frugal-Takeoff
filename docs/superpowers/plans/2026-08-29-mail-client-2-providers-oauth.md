# Mail Client — Plan 2 of 4: Providers (IMAP, Gmail API, Microsoft Graph) + OAuth

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "provider not installed" stub from Plan 1 with three real `MailProvider` implementations, the OAuth start/callback routes for Google and Microsoft, the Graph change-notification webhook, IMAP IDLE push, and the admin setup runbook — so real mailboxes sync and send.

**Architecture:** Each provider is a class implementing the Plan 1 `MailProvider` contract, constructed by `createMailProvider(account, auth)` in `server/mail/providers/index.ts`. OAuth providers get a `TokenSource` that refreshes access tokens from the sealed refresh token and caches them in memory. Provider network calls go through a thin injectable HTTP/client layer so contract tests run against recorded fixtures, never the network. Push arrives via `MailScheduler.pokeAccount`.

**Tech Stack:** `imapflow` (IMAP), `nodemailer` (SMTP, already installed), `mailparser` (IMAP body parsing), `googleapis` (Gmail API + OAuth2 client), `@azure/msal-node` (Microsoft OAuth) + Graph REST via global `fetch` (Node 20), `jsonwebtoken` (OAuth state).

**Spec:** `docs/superpowers/specs/2026-08-29-mail-client-design.md` §4.1, §4.2, §4.4 (oauth/webhook rows), §6, §7, §8.

## Global Constraints

- All Plan 1 constraints apply (see `2026-08-29-mail-client-1-server-foundation.md` "Global Constraints" and "Shared interface contract").
- Providers throw `AuthExpiredError` **only** when the token/credential is rejected (HTTP 401 with `invalid_grant`/`invalid_client`, IMAP `AUTHENTICATIONFAILED`), never on network/5xx/429. 429 → `RateLimitedError`.
- No provider call from a route may take more than 30 s — pass `AbortSignal.timeout(30_000)` to fetch / set `socketTimeout` on imapflow.
- No network in tests: every provider takes its client/HTTP function through the constructor; contract tests use fixtures in `server/mail/providers/__fixtures__/`.
- Redirect URIs are exactly `${APP_PUBLIC_URL}/api/mail/oauth/google/callback` and `${APP_PUBLIC_URL}/api/mail/oauth/microsoft/callback`; webhook `${APP_PUBLIC_URL}/api/mail/ms/webhook`.
- Env: `APP_PUBLIC_URL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET`, `MS_OAUTH_TENANT` (default `common`).

## File map

| File | Responsibility |
|---|---|
| `server/mail/providers/index.ts` | `createMailProvider(account, auth, deps?)` factory + `TokenSource` |
| `server/mail/providers/tokenSource.ts` | refresh-token → access-token cache (google/microsoft) |
| `server/mail/providers/imap.ts` | `ImapMailProvider` (imapflow + nodemailer + mailparser), IDLE → `onPush` |
| `server/mail/providers/google.ts` | `GmailProvider` (googleapis) |
| `server/mail/providers/microsoft.ts` | `GraphProvider` (fetch to graph.microsoft.com/v1.0) |
| `server/mail/providers/mimeBuild.ts` | build RFC 2822 raw message with nodemailer's `MailComposer` (used by Gmail `messages.send` raw + IMAP APPEND) |
| `server/mail/oauth.ts` | start/callback handlers, state JWT, PKCE |
| `server/mail/push.ts` | Graph subscription create/renew + webhook handler; IMAP push registration |
| `server/mail/routes.ts` | replace the 501 stub; add callback + webhook routes |
| `server/mail/sync/scheduler.ts` | after `startAccount`, call `provider.startPush?.(() => pokeAccount(id))`; on stop, `provider.stopPush?.()` |
| `docs/mail-setup.md` | admin runbook |

Extend the `MailProvider` contract (Plan 1 `types.ts`) with two **optional** members: `startPush?(onChange: () => void): Promise<void>` and `stopPush?(): Promise<void>`.

---

### Task 1: Install dependencies; `TokenSource`; provider factory

**Files:**
- Modify: `package.json`
- Create: `server/mail/providers/tokenSource.ts`, `server/mail/providers/index.ts`
- Test: `server/mail/providers/tokenSource.test.ts`, `server/mail/providers/index.test.ts`

**Interfaces:**
- `class TokenSource { constructor(opts: { refreshToken: string; refresh: (refreshToken: string) => Promise<{ accessToken: string; expiresInSec: number; refreshToken?: string }>; onRotate?: (newRefreshToken: string) => void; now?: () => number }); get(): Promise<string>; invalidate(): void }` — caches until 60 s before expiry; a refresh failure whose error message matches `/invalid_grant|invalid_client|unauthorized_client|AADSTS(50173|700082|70008)/` throws `AuthExpiredError`, else rethrows.
- `createMailProvider(account: MailAccountRow, auth: ImapAuth | OAuthAuth, deps: ProviderDeps = defaultDeps): MailProvider` where `ProviderDeps = { env: NodeJS.ProcessEnv; db: Database.Database; crypto: MailCrypto; fetch: typeof fetch }`. Chooses: `account.provider === 'fake'` or `env.MAIL_FAKE_PROVIDER === '1'` → `getFakeProvider(account.id)`; `'imap'` → `new ImapMailProvider(auth as ImapAuth, {...})`; `'google'` → `new GmailProvider(tokenSource, ...)`; `'microsoft'` → `new GraphProvider(tokenSource, deps.fetch)`. `onRotate` persists a rotated refresh token via `accounts.updateAuth`.

- [ ] **Step 1: Install**

Run: `npm i imapflow mailparser googleapis @azure/msal-node && npm i -D @types/mailparser`
(`imapflow` ships its own types. Pin exact versions in package.json.)

- [ ] **Step 2: Write the failing tests**

```ts
// server/mail/providers/tokenSource.test.ts
import { describe, it, expect } from 'vitest';
import { TokenSource } from './tokenSource';
import { AuthExpiredError } from './types';

describe('TokenSource', () => {
  it('refreshes once and caches until near expiry', async () => {
    let calls = 0; let now = 0;
    const ts = new TokenSource({ refreshToken: 'r', refresh: async () => { calls++; return { accessToken: 'a' + calls, expiresInSec: 3600 }; }, now: () => now });
    expect(await ts.get()).toBe('a1'); expect(await ts.get()).toBe('a1');
    now = 3600_000 - 30_000; expect(await ts.get()).toBe('a2');
  });
  it('rotates the refresh token through onRotate', async () => {
    let rotated = ''; const ts = new TokenSource({ refreshToken: 'r', refresh: async () => ({ accessToken: 'a', expiresInSec: 10, refreshToken: 'r2' }), onRotate: t => { rotated = t; } });
    await ts.get(); expect(rotated).toBe('r2');
  });
  it('maps invalid_grant to AuthExpiredError, other errors pass through', async () => {
    const bad = new TokenSource({ refreshToken: 'r', refresh: async () => { throw new Error('invalid_grant: Token has been expired or revoked.'); } });
    await expect(bad.get()).rejects.toBeInstanceOf(AuthExpiredError);
    const net = new TokenSource({ refreshToken: 'r', refresh: async () => { throw new Error('ECONNRESET'); } });
    await expect(net.get()).rejects.toThrow('ECONNRESET');
  });
});
```

```ts
// server/mail/providers/index.test.ts
import { describe, it, expect } from 'vitest';
import { createMailProvider } from './index';
import { FakeMailProvider } from './fake';
import { ImapMailProvider } from './imap';
import { GmailProvider } from './google';
import { GraphProvider } from './microsoft';
const base: any = { id: 'a1', userId: 'u1', emailAddress: 'x@y', displayName: null };
const deps: any = { env: {}, db: null, crypto: null, fetch: async () => new Response('{}') };
describe('createMailProvider', () => {
  it('routes by account.provider', () => {
    expect(createMailProvider({ ...base, provider: 'fake' }, { refreshToken: 'r' }, deps)).toBeInstanceOf(FakeMailProvider);
    expect(createMailProvider({ ...base, provider: 'imap' }, { imapHost: 'h', imapPort: 993, imapSecure: true, smtpHost: 's', smtpPort: 587, smtpSecure: false, username: 'u', password: 'p' }, deps)).toBeInstanceOf(ImapMailProvider);
    expect(createMailProvider({ ...base, provider: 'google' }, { refreshToken: 'r' }, { ...deps, env: { GOOGLE_OAUTH_CLIENT_ID: 'i', GOOGLE_OAUTH_CLIENT_SECRET: 's' } })).toBeInstanceOf(GmailProvider);
    expect(createMailProvider({ ...base, provider: 'microsoft' }, { refreshToken: 'r' }, { ...deps, env: { MS_OAUTH_CLIENT_ID: 'i', MS_OAUTH_CLIENT_SECRET: 's' } })).toBeInstanceOf(GraphProvider);
  });
  it('MAIL_FAKE_PROVIDER=1 forces the fake for every provider kind', () => {
    expect(createMailProvider({ ...base, provider: 'google' }, { refreshToken: 'r' }, { ...deps, env: { MAIL_FAKE_PROVIDER: '1' } })).toBeInstanceOf(FakeMailProvider);
  });
  it('throws a clear error when OAuth env is missing', () => {
    expect(() => createMailProvider({ ...base, provider: 'google' }, { refreshToken: 'r' }, deps)).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });
});
```

(The `index.test.ts` will only pass once Tasks 2–4 export the classes — write it now, run it at the end of Task 4.)

- [ ] **Step 3: Implement `tokenSource.ts`**

```ts
// server/mail/providers/tokenSource.ts
import { AuthExpiredError } from './types';
const FATAL = /invalid_grant|invalid_client|unauthorized_client|AADSTS(50173|700082|70008|7000215)/i;
export class TokenSource {
  private token: string | null = null; private expiresAt = 0; private inflight: Promise<string> | null = null;
  private readonly now: () => number;
  constructor(private opts: { refreshToken: string; refresh: (rt: string) => Promise<{ accessToken: string; expiresInSec: number; refreshToken?: string }>; onRotate?: (rt: string) => void; now?: () => number }) { this.now = opts.now ?? (() => Date.now()); }
  invalidate(): void { this.token = null; this.expiresAt = 0; }
  async get(): Promise<string> {
    if (this.token && this.now() < this.expiresAt - 60_000) return this.token;
    if (!this.inflight) this.inflight = (async () => {
      try {
        const r = await this.opts.refresh(this.opts.refreshToken);
        this.token = r.accessToken; this.expiresAt = this.now() + r.expiresInSec * 1000;
        if (r.refreshToken && r.refreshToken !== this.opts.refreshToken) { this.opts.refreshToken = r.refreshToken; this.opts.onRotate?.(r.refreshToken); }
        return this.token;
      } catch (e: any) { if (FATAL.test(String(e?.message ?? e))) throw new AuthExpiredError(e.message); throw e; }
      finally { this.inflight = null; }
    })();
    return this.inflight;
  }
}
```

- [ ] **Step 4: Implement `index.ts`**

```ts
// server/mail/providers/index.ts
import type Database from 'better-sqlite3';
import type { MailAccountRow, ImapAuth, OAuthAuth } from '../accountStore';
import * as accounts from '../accountStore';
import type { MailCrypto } from '../crypto';
import type { MailProvider } from './types';
import { getFakeProvider } from './fakeRegistry';
import { ImapMailProvider } from './imap';
import { GmailProvider, googleRefresh } from './google';
import { GraphProvider, microsoftRefresh } from './microsoft';
import { TokenSource } from './tokenSource';

export interface ProviderDeps { env: NodeJS.ProcessEnv; db: Database.Database; crypto: MailCrypto; fetch: typeof fetch }
export const defaultProviderDeps = (db: Database.Database, crypto: MailCrypto): ProviderDeps => ({ env: process.env, db, crypto, fetch: globalThis.fetch });

function need(env: NodeJS.ProcessEnv, ...keys: string[]): void { for (const k of keys) if (!env[k]) throw new Error(`${k} is not set — see Settings → Mail → Server setup guide`); }

export function createMailProvider(account: MailAccountRow, auth: ImapAuth | OAuthAuth, deps: ProviderDeps): MailProvider {
  if (deps.env.MAIL_FAKE_PROVIDER === '1' || account.provider === 'fake') return getFakeProvider(account.id);
  const onRotate = (rt: string) => { if (deps.db) accounts.updateAuth(deps.db, deps.crypto, account.id, { refreshToken: rt }); };
  switch (account.provider) {
    case 'imap': return new ImapMailProvider(auth as ImapAuth, { fromAddress: account.emailAddress });
    case 'google': {
      need(deps.env, 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET');
      const ts = new TokenSource({ refreshToken: (auth as OAuthAuth).refreshToken, refresh: rt => googleRefresh(deps.env, rt, deps.fetch), onRotate });
      return new GmailProvider(ts, { fetch: deps.fetch, emailAddress: account.emailAddress });
    }
    case 'microsoft': {
      need(deps.env, 'MS_OAUTH_CLIENT_ID', 'MS_OAUTH_CLIENT_SECRET');
      const ts = new TokenSource({ refreshToken: (auth as OAuthAuth).refreshToken, refresh: rt => microsoftRefresh(deps.env, rt, deps.fetch), onRotate });
      return new GraphProvider(ts, { fetch: deps.fetch });
    }
    default: throw new Error(`Unknown mail provider ${account.provider}`);
  }
}
```

In `server.ts` (Plan 1 Task 13 wiring) replace the stub factory with `providerFactory: (a, auth) => createMailProvider(a, auth, defaultProviderDeps(db, mailCrypto))` and delete the stub file if one was created.

- [ ] **Step 5: Run** → `npx vitest run --project server server/mail/providers/tokenSource.test.ts` passes; `index.test.ts` deferred to Task 4.

- [ ] **Step 6: Commit** — `git add package.json package-lock.json server/mail/providers/tokenSource.ts server/mail/providers/tokenSource.test.ts server/mail/providers/index.ts server/mail/providers/index.test.ts server.ts && git commit -m "feat(mail): token source and provider factory"`

---

### Task 2: IMAP provider

**Files:**
- Create: `server/mail/providers/imap.ts`, `server/mail/providers/mimeBuild.ts`
- Test: `server/mail/providers/imap.test.ts`, `server/mail/providers/mimeBuild.test.ts`

**Interfaces:**
- `buildRawMime(msg: OutgoingMessage): Promise<Buffer>` — uses `nodemailer/lib/mail-composer` (`import MailComposer from 'nodemailer/lib/mail-composer/index.js'`) with `messageId: '<' + msg.messageIdHeader + '>'`, `inReplyTo`, `references`, html+text alternative, attachments (`cid` for inline).
- `class ImapMailProvider implements MailProvider { constructor(auth: ImapAuth, opts: { fromAddress: string; clientFactory?: (auth) => ImapClientLike; transportFactory?: (auth) => { sendMail(o): Promise<unknown> } }) }`. `ImapClientLike` is the subset of `ImapFlow` used: `connect, logout, list, mailboxOpen, fetch (async iterable), fetchOne, download, messageFlagsAdd/Remove, messageMove, messageDelete, append, search, idle, on('exists')`, plus `mailbox` (current). Default factories create real `ImapFlow`/nodemailer instances. Tests inject a scripted fake client.
- Sync state: `{ folders: { [path]: { uidValidity: number; lastUid: number; flagsHash?: string } } }`. `backfill` walks every selectable folder except `\Junk`/`\Trash` (`SINCE <indexedSince>`); `incremental` per folder fetches `UID lastUid+1:*` plus a flags re-scan of the last 500 UIDs to catch read/star changes (diff against stored `isRead/isStarred` is done by the engine's upsert). Special-use folders map to roles via `\Inbox/\Sent/\Drafts/\Trash/\Junk/\Archive/\Flagged` attributes, with name fallbacks (`Sent`, `Sent Items`, `Sent Mail`, `Drafts`, `Trash`, `Deleted Items`, `Junk`, `Spam`, `Archive`).
- `providerMessageId` format: `${folderPath} ${uidValidity} ${uid}` (a single string so the engine's unique index works); helper `parsePmid(id)`.
- `send`: nodemailer SMTP `sendMail({ raw: buildRawMime(msg) })` then `append` to the Sent folder with `\Seen`; returns `providerMessageId` of the appended copy (from `append` result `uid`) — if append fails, still return success with a synthetic id `sent 0 <messageIdHeader>` (logged).
- `getBody`: `download(uid, undefined, { uid: true })` → `mailparser.simpleParser` → `{ html, text, attachments: [{ attId: <index>, name, mime, size, contentId }] }`; `getAttachment` re-downloads the part by `BODYSTRUCTURE` part id (`attId` = part path like `2` / `1.2`, computed from `fetchOne(uid, { bodyStructure: true })`).
- `startPush(onChange)`: keeps a second connection open on INBOX in `idle()`; on `exists` → `onChange()`; reconnects with backoff on close. `stopPush` logs out.

- [ ] **Step 1: Write the failing tests**

```ts
// server/mail/providers/mimeBuild.test.ts
import { describe, it, expect } from 'vitest';
import { buildRawMime } from './mimeBuild';
describe('buildRawMime', () => {
  it('produces a multipart message with headers and attachment', async () => {
    const raw = (await buildRawMime({ from: { addr: 'me@x.com', name: 'Me' }, to: [{ addr: 'you@y.com' }], cc: [], bcc: [], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi',
      attachments: [{ name: 'a.pdf', mime: 'application/pdf', content: Buffer.from('%PDF') }], inReplyTo: 'p@y.com', references: ['r@y.com', 'p@y.com'], messageIdHeader: 'm@x.com' })).toString();
    expect(raw).toMatch(/^From: "?Me"? <me@x.com>/m); expect(raw).toMatch(/^Message-ID: <m@x.com>/m);
    expect(raw).toMatch(/^In-Reply-To: <p@y.com>/m); expect(raw).toMatch(/^References: <r@y.com> <p@y.com>/m);
    expect(raw).toContain('Content-Type: application/pdf'); expect(raw).toContain('filename=a.pdf'); expect(raw).toContain('text/html');
  });
});
```

```ts
// server/mail/providers/imap.test.ts  — scripted fake ImapFlow
import { describe, it, expect } from 'vitest';
import { ImapMailProvider, parsePmid } from './imap';
import { AuthExpiredError } from './types';

function fakeClient(script: { folders?: any[]; messages?: Record<string, any[]>; authFail?: boolean }) {
  const flags = new Map<string, Set<string>>();
  const client: any = {
    mailbox: null, calls: [] as any[],
    async connect() { if (script.authFail) { const e: any = new Error('Invalid credentials'); e.authenticationFailed = true; throw e; } },
    async logout() {},
    async list() { return script.folders ?? [{ path: 'INBOX', specialUse: '\\Inbox', flags: new Set() }, { path: 'Sent', specialUse: '\\Sent', flags: new Set() }, { path: 'Drafts', specialUse: '\\Drafts', flags: new Set() }, { path: 'Trash', specialUse: '\\Trash', flags: new Set() }]; },
    async mailboxOpen(path: string) { client.mailbox = { path, uidValidity: 7n, exists: (script.messages?.[path] ?? []).length }; return client.mailbox; },
    async *fetch(range: any, _q: any, _o: any) { for (const m of script.messages?.[client.mailbox.path] ?? []) yield m; },
    async fetchOne() { return { bodyStructure: { childNodes: [{ part: '1', type: 'text/html' }, { part: '2', type: 'application/pdf', dispositionParameters: { filename: 'a.pdf' }, size: 4 }] } }; },
    async download(uid: any, part: any) { client.calls.push(['download', uid, part]); return { content: require('stream').Readable.from(part ? Buffer.from('%PDF') : Buffer.from('From: a@b\r\nSubject: s\r\nContent-Type: text/html\r\n\r\n<p>Body</p>')), meta: { contentType: part ? 'application/pdf' : 'message/rfc822', filename: part ? 'a.pdf' : undefined } }; },
    async messageFlagsAdd(range: any, f: string[]) { client.calls.push(['add', range, f]); }, async messageFlagsRemove(range: any, f: string[]) { client.calls.push(['remove', range, f]); },
    async messageMove(range: any, dest: string) { client.calls.push(['move', range, dest]); }, async append(path: string, raw: Buffer, fl: string[]) { client.calls.push(['append', path, fl]); return { uid: 99, uidValidity: 7n }; },
    async search() { return [1]; }, async idle() { return true; }, on() {},
  };
  return client;
}
const auth = { imapHost: 'h', imapPort: 993, imapSecure: true, smtpHost: 's', smtpPort: 587, smtpSecure: false, username: 'u', password: 'p' };
const env = (uid: number, o: any = {}) => ({ uid, envelope: { messageId: `<m${uid}@x>`, subject: 'Hello', from: [{ address: 'a@b.com', name: 'A' }], to: [{ address: 'me@x' }], cc: [], date: new Date('2026-08-10T00:00:00Z'), inReplyTo: null }, flags: new Set<string>(), size: 123, internalDate: new Date('2026-08-10T00:00:00Z'), headers: Buffer.from('References: <r@x>\r\n'), bodyStructure: { childNodes: [] }, ...o });

describe('ImapMailProvider', () => {
  it('lists folders with roles', async () => {
    const p = new ImapMailProvider(auth, { fromAddress: 'me@x', clientFactory: () => fakeClient({}) });
    const f = await p.listFolders(); expect(f.find(x => x.providerId === 'Sent')!.role).toBe('sent'); expect(f.find(x => x.providerId === 'INBOX')!.role).toBe('inbox');
  });
  it('backfill maps envelopes (references from headers, flags → isRead/isStarred, attachments from structure)', async () => {
    const c = fakeClient({ messages: { INBOX: [env(5, { flags: new Set(['\\Seen', '\\Flagged']), bodyStructure: { childNodes: [{ part: '1', type: 'text/plain' }, { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' }, size: 4 }] } })] } });
    const p = new ImapMailProvider(auth, { fromAddress: 'me@x', clientFactory: () => c });
    const r = await p.backfill({ since: new Date('2026-01-01') });
    const m = r.messages[0];
    expect(parsePmid(m.providerMessageId)).toEqual({ folder: 'INBOX', uidValidity: 7, uid: 5 });
    expect(m).toMatchObject({ messageIdHeader: 'm5@x', references: ['r@x'], isRead: true, isStarred: true, subject: 'Hello', from: { addr: 'a@b.com', name: 'A' }, folderProviderIds: ['INBOX'] });
    expect(m.attachments[0]).toMatchObject({ attId: '2', name: 'a.pdf', mime: 'application/pdf' });
    expect(r.done).toBe(true);
  });
  it('incremental fetches UIDs above lastUid per folder and updates state', async () => {
    const c = fakeClient({ messages: { INBOX: [env(9)] } });
    const p = new ImapMailProvider(auth, { fromAddress: 'me@x', clientFactory: () => c });
    const r = await p.incremental({ folders: { INBOX: { uidValidity: 7, lastUid: 8 } } });
    expect(r.upserts.map(u => parsePmid(u.providerMessageId).uid)).toEqual([9]);
    expect((r.state as any).folders.INBOX.lastUid).toBe(9);
  });
  it('getBody parses the RFC822 download; getAttachment downloads the part', async () => {
    const c = fakeClient({}); const p = new ImapMailProvider(auth, { fromAddress: 'me@x', clientFactory: () => c });
    const b = await p.getBody('INBOX 7 5'); expect(b.html).toContain('<p>Body</p>');
    const a = await p.getAttachment('INBOX 7 5', '2'); expect(a.mime).toBe('application/pdf'); expect(a.name).toBe('a.pdf');
  });
  it('setFlags/move/trash/archive translate to imap ops', async () => {
    const c = fakeClient({}); const p = new ImapMailProvider(auth, { fromAddress: 'me@x', clientFactory: () => c });
    await p.setFlags(['INBOX 7 5'], { read: true, starred: false });
    expect(c.calls).toContainEqual(['add', { uid: '5' }, ['\\Seen']]); expect(c.calls).toContainEqual(['remove', { uid: '5' }, ['\\Flagged']]);
    await p.trash(['INBOX 7 5']); expect(c.calls).toContainEqual(['move', { uid: '5' }, 'Trash']);
  });
  it('send uses SMTP then appends to Sent', async () => {
    const c = fakeClient({}); const sent: any[] = [];
    const p = new ImapMailProvider(auth, { fromAddress: 'me@x', clientFactory: () => c, transportFactory: () => ({ sendMail: async (o: any) => { sent.push(o); return {}; } }) });
    const r = await p.send({ from: { addr: 'me@x' }, to: [{ addr: 'y@z' }], cc: [], bcc: [], subject: 's', html: '<p>h</p>', text: 'h', attachments: [], messageIdHeader: 'mid@x' });
    expect(sent.length).toBe(1); expect(c.calls.some(x => x[0] === 'append' && x[1] === 'Sent')).toBe(true); expect(parsePmid(r.providerMessageId).uid).toBe(99);
  });
  it('authentication failure → AuthExpiredError', async () => {
    const p = new ImapMailProvider(auth, { fromAddress: 'me@x', clientFactory: () => fakeClient({ authFail: true }) });
    await expect(p.listFolders()).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `mimeBuild.ts`**

```ts
// server/mail/providers/mimeBuild.ts
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { OutgoingMessage } from './types';
import { formatAddress } from '../mime';
export async function buildRawMime(msg: OutgoingMessage): Promise<Buffer> {
  const composer = new MailComposer({
    from: formatAddress(msg.from), to: msg.to.map(formatAddress).join(', '), cc: msg.cc.map(formatAddress).join(', ') || undefined, bcc: msg.bcc.map(formatAddress).join(', ') || undefined,
    subject: msg.subject, html: msg.html, text: msg.text, messageId: `<${msg.messageIdHeader}>`,
    inReplyTo: msg.inReplyTo ? `<${msg.inReplyTo}>` : undefined, references: msg.references?.length ? msg.references.map(r => `<${r}>`).join(' ') : undefined,
    attachments: msg.attachments.map(a => ({ filename: a.name, content: a.content, contentType: a.mime, cid: a.contentId })),
  });
  return composer.compile().build();
}
```

If TypeScript can't find types for `nodemailer/lib/mail-composer/index.js`, add `declare module 'nodemailer/lib/mail-composer/index.js';` to `server/types.d.ts` (create if absent and ensure it is included by `tsconfig`).

- [ ] **Step 4: Implement `imap.ts`**

Write the full class per the interface above. Essentials:

```ts
// server/mail/providers/imap.ts
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import type { ImapAuth } from '../accountStore';
import type { MailProvider, Envelope, ProviderFolder, SyncState, OutgoingMessage, AttachmentMeta, FolderRole } from './types';
import { AuthExpiredError, ProviderNotFoundError } from './types';
import { buildRawMime } from './mimeBuild';
import { normalizeMessageId, } from '../threadKey';
import { snippetOf } from '../mime';

const SEP = ' ';
export const makePmid = (folder: string, uidValidity: number, uid: number) => `${folder}${SEP}${uidValidity}${SEP}${uid}`;
export function parsePmid(id: string): { folder: string; uidValidity: number; uid: number } { const [folder, v, u] = id.split(SEP); return { folder, uidValidity: Number(v), uid: Number(u) }; }

const ROLE_BY_USE: Record<string, FolderRole> = { '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'spam', '\\Archive': 'archive', '\\Flagged': 'starred' };
const ROLE_BY_NAME: Array<[RegExp, FolderRole]> = [[/^inbox$/i, 'inbox'], [/^(sent|sent items|sent mail|sent messages)$/i, 'sent'], [/^drafts?$/i, 'drafts'], [/^(trash|deleted items|deleted messages|bin)$/i, 'trash'], [/^(junk|spam|junk e-?mail)$/i, 'spam'], [/^archives?$/i, 'archive']];

export interface ImapClientLike { /* subset used — see task interfaces */ [k: string]: any }
type Opts = { fromAddress: string; clientFactory?: (auth: ImapAuth) => ImapClientLike; transportFactory?: (auth: ImapAuth) => { sendMail(o: any): Promise<unknown> } };

export class ImapMailProvider implements MailProvider {
  kind = 'imap' as const;
  private pushClient: ImapClientLike | null = null; private pushStopped = false;
  constructor(private auth: ImapAuth, private opts: Opts) {}
  private newClient(): ImapClientLike {
    return this.opts.clientFactory ? this.opts.clientFactory(this.auth)
      : new ImapFlow({ host: this.auth.imapHost, port: this.auth.imapPort, secure: this.auth.imapSecure, auth: { user: this.auth.username, pass: this.auth.password }, logger: false, socketTimeout: 30_000 });
  }
  private async withClient<T>(fn: (c: ImapClientLike) => Promise<T>): Promise<T> {
    const c = this.newClient();
    try { await c.connect(); } catch (e: any) { if (e?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(String(e?.message))) throw new AuthExpiredError('IMAP login rejected'); throw e; }
    try { return await fn(c); } finally { try { await c.logout(); } catch { /* ignore */ } }
  }
  private roleOf(box: any): FolderRole | null { if (box.specialUse && ROLE_BY_USE[box.specialUse]) return ROLE_BY_USE[box.specialUse]; const name = String(box.path).split(box.delimiter || '/').pop() || ''; for (const [re, role] of ROLE_BY_NAME) if (re.test(name)) return role; return null; }
  async listFolders(): Promise<ProviderFolder[]> {
    return this.withClient(async c => (await c.list()).filter((b: any) => !b.flags?.has?.('\\Noselect')).map((b: any, i: number): ProviderFolder => ({ providerId: b.path, name: b.name || b.path, role: this.roleOf(b), sortOrder: i })));
  }
  private toEnvelope(folder: string, uidValidity: number, m: any): Envelope {
    const e = m.envelope || {}; const headers = m.headers ? m.headers.toString() : '';
    const refs = (/^references:\s*(.+(?:\r?\n[ \t].+)*)/im.exec(headers)?.[1] || '').match(/<[^>]+>/g)?.map((x: string) => normalizeMessageId(x)!) ?? [];
    const addr = (a: any) => ({ addr: String(a.address || '').toLowerCase(), ...(a.name ? { name: a.name } : {}) });
    const attachments = this.attachmentsOf(m.bodyStructure);
    const flags: Set<string> = m.flags ?? new Set();
    return { providerMessageId: makePmid(folder, uidValidity, m.uid), messageIdHeader: normalizeMessageId(e.messageId) ?? undefined, inReplyTo: normalizeMessageId(e.inReplyTo) ?? undefined, references: refs,
      from: e.from?.[0] ? addr(e.from[0]) : { addr: '' }, to: (e.to ?? []).map(addr), cc: (e.cc ?? []).map(addr), bcc: (e.bcc ?? []).map(addr), subject: e.subject || '', snippet: '', date: (e.date ?? m.internalDate ?? new Date()).toISOString(),
      isRead: flags.has('\\Seen'), isStarred: flags.has('\\Flagged'), isDraft: flags.has('\\Draft'), attachments, sizeBytes: m.size ?? 0, folderProviderIds: [folder] };
  }
  private attachmentsOf(bs: any): AttachmentMeta[] {
    const out: AttachmentMeta[] = []; const walk = (n: any) => { if (!n) return; if (n.childNodes?.length) n.childNodes.forEach(walk);
      else if (n.disposition === 'attachment' || (n.dispositionParameters?.filename) || (n.parameters?.name) || (n.type && !/^text\//i.test(n.type) && !/^multipart\//i.test(n.type))) { if (n.type === 'text/plain' || n.type === 'text/html') return;
        out.push({ attId: String(n.part), name: n.dispositionParameters?.filename || n.parameters?.name || 'attachment', mime: n.type || 'application/octet-stream', size: n.size || 0, contentId: n.id ? String(n.id).replace(/^<|>$/g, '') : undefined }); } };
    walk(bs); return out;
  }
  private async scanFolder(c: ImapClientLike, path: string, range: string | { since: Date }, limit?: number): Promise<{ uidValidity: number; msgs: Envelope[]; maxUid: number }> {
    const box = await c.mailboxOpen(path); const uidValidity = Number(box.uidValidity); const msgs: Envelope[] = []; let maxUid = 0;
    const q = typeof range === 'string' ? range : { since: range.since };
    for await (const m of c.fetch(q, { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true, headers: ['references'] }, { uid: true })) { msgs.push(this.toEnvelope(path, uidValidity, m)); if (m.uid > maxUid) maxUid = m.uid; if (limit && msgs.length >= limit) break; }
    return { uidValidity, msgs, maxUid };
  }
  async backfill(opts: { since: Date; cursor?: string }) {
    return this.withClient(async c => {
      const folders = (await c.list()).filter((b: any) => !b.flags?.has?.('\\Noselect') && !['\\Junk', '\\Trash'].includes(b.specialUse));
      const messages: Envelope[] = [];
      for (const b of folders) { const r = await this.scanFolder(c, b.path, { since: opts.since }); messages.push(...r.msgs); }
      return { messages, done: true };
    });
  }
  async incremental(state: SyncState) {
    const st = (state as any).folders ? JSON.parse(JSON.stringify(state)) as { folders: Record<string, { uidValidity: number; lastUid: number }> } : { folders: {} };
    return this.withClient(async c => {
      const upserts: Envelope[] = []; const deletes: string[] = [];
      const boxes = (await c.list()).filter((b: any) => !b.flags?.has?.('\\Noselect'));
      for (const b of boxes) {
        const prev = st.folders[b.path]; const box = await c.mailboxOpen(b.path); const uidValidity = Number(box.uidValidity);
        if (!prev || prev.uidValidity !== uidValidity) { st.folders[b.path] = { uidValidity, lastUid: Number(box.uidNext ?? 1) - 1 }; continue; }   // new/reset folder: index from now on
        const r = await this.scanFolder(c, b.path, `${prev.lastUid + 1}:*`); upserts.push(...r.msgs.filter(m => parsePmid(m.providerMessageId).uid > prev.lastUid));
        // flag re-scan of the most recent 200 known UIDs so read/star changes made elsewhere show up
        if (prev.lastUid > 0) { const from = Math.max(1, prev.lastUid - 200); const f = await this.scanFolder(c, b.path, `${from}:${prev.lastUid}`); upserts.push(...f.msgs); }
        st.folders[b.path].lastUid = Math.max(prev.lastUid, r.maxUid);
      }
      return { upserts, deletes, state: st };
    });
  }
  async getBody(pmid: string) {
    const { folder, uid } = parsePmid(pmid);
    return this.withClient(async c => { await c.mailboxOpen(folder); const dl = await c.download(String(uid), undefined, { uid: true }); if (!dl?.content) throw new ProviderNotFoundError(pmid);
      const parsed = await simpleParser(dl.content);
      const attachments: AttachmentMeta[] = this.attachmentsOf((await c.fetchOne(String(uid), { bodyStructure: true }, { uid: true }))?.bodyStructure);
      return { html: parsed.html || undefined, text: parsed.text || undefined, attachments }; });
  }
  async getAttachment(pmid: string, attId: string) {
    const { folder, uid } = parsePmid(pmid);
    const c = this.newClient(); await c.connect(); await c.mailboxOpen(folder);
    const dl = await c.download(String(uid), attId, { uid: true }); if (!dl?.content) { await c.logout(); throw new ProviderNotFoundError(attId); }
    dl.content.on('end', () => c.logout().catch(() => {})); dl.content.on('error', () => c.logout().catch(() => {}));
    return { stream: dl.content, mime: dl.meta?.contentType || 'application/octet-stream', size: dl.meta?.expectedSize, name: dl.meta?.filename || 'attachment' };
  }
  private groupByFolder(ids: string[]) { const m = new Map<string, number[]>(); ids.map(parsePmid).forEach(p => m.set(p.folder, [...(m.get(p.folder) ?? []), p.uid])); return m; }
  async setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }) {
    await this.withClient(async c => { for (const [folder, uids] of this.groupByFolder(ids)) { await c.mailboxOpen(folder); const range = { uid: uids.join(',') };
      if (flags.read !== undefined) await (flags.read ? c.messageFlagsAdd(range, ['\\Seen']) : c.messageFlagsRemove(range, ['\\Seen']));
      if (flags.starred !== undefined) await (flags.starred ? c.messageFlagsAdd(range, ['\\Flagged']) : c.messageFlagsRemove(range, ['\\Flagged'])); } });
  }
  async move(ids: string[], dest: string) { await this.withClient(async c => { for (const [folder, uids] of this.groupByFolder(ids)) { await c.mailboxOpen(folder); await c.messageMove({ uid: uids.join(',') }, dest); } }); }
  private async roleFolder(c: ImapClientLike, role: FolderRole, fallback: string): Promise<string> { const b = (await c.list()).find((x: any) => this.roleOf(x) === role); return b?.path ?? fallback; }
  async archive(ids: string[]) { const dest = await this.withClient(c => this.roleFolder(c, 'archive', 'Archive')); await this.move(ids, dest); }
  async trash(ids: string[]) { const dest = await this.withClient(c => this.roleFolder(c, 'trash', 'Trash')); await this.move(ids, dest); }
  async send(msg: OutgoingMessage) {
    const raw = await buildRawMime(msg);
    const transport = this.opts.transportFactory ? this.opts.transportFactory(this.auth) : nodemailer.createTransport({ host: this.auth.smtpHost, port: this.auth.smtpPort, secure: this.auth.smtpSecure, auth: { user: this.auth.username, pass: this.auth.password } });
    try { await transport.sendMail({ envelope: { from: msg.from.addr, to: [...msg.to, ...msg.cc, ...msg.bcc].map(a => a.addr) }, raw }); }
    catch (e: any) { if (/535|Invalid login|authentication failed/i.test(String(e?.message))) throw new AuthExpiredError('SMTP login rejected'); throw e; }
    try { return await this.withClient(async c => { const sent = await this.roleFolder(c, 'sent', 'Sent'); const r = await c.append(sent, raw, ['\\Seen']); return { providerMessageId: makePmid(sent, Number(r?.uidValidity ?? 0), Number(r?.uid ?? 0)) }; }); }
    catch (e) { console.warn('[imap] append to Sent failed', (e as Error).message); return { providerMessageId: makePmid('sent', 0, 0) + SEP + msg.messageIdHeader }; }
  }
  async saveDraft(draft: OutgoingMessage, existing?: string) {
    const raw = await buildRawMime(draft);
    return this.withClient(async c => { const drafts = await this.roleFolder(c, 'drafts', 'Drafts'); if (existing) { const p = parsePmid(existing); await c.mailboxOpen(p.folder); await c.messageDelete({ uid: String(p.uid) }); }
      const r = await c.append(drafts, raw, ['\\Draft', '\\Seen']); return { providerMessageId: makePmid(drafts, Number(r?.uidValidity ?? 0), Number(r?.uid ?? 0)) }; });
  }
  async deleteDraft(pmid: string) { const p = parsePmid(pmid); await this.withClient(async c => { await c.mailboxOpen(p.folder); await c.messageDelete({ uid: String(p.uid) }); }); }
  async search(query: string, opts: { before?: Date; limit: number }) {
    return this.withClient(async c => { const out: Envelope[] = []; for (const b of (await c.list()).filter((x: any) => !x.flags?.has?.('\\Noselect'))) { const box = await c.mailboxOpen(b.path);
      const uids: number[] = await c.search({ or: [{ subject: query }, { from: query }, { body: query }], ...(opts.before ? { before: opts.before } : {}) }, { uid: true }); if (!uids?.length) continue;
      const r = await this.scanFolder(c, b.path, uids.slice(-opts.limit).join(','), opts.limit); out.push(...r.msgs); void box; if (out.length >= opts.limit) break; } return out.slice(0, opts.limit); });
  }
  async startPush(onChange: () => void) {
    this.pushStopped = false;
    const loop = async () => { let delay = 5_000; while (!this.pushStopped) { const c = this.newClient(); this.pushClient = c;
      try { await c.connect(); await c.mailboxOpen('INBOX'); delay = 5_000; c.on('exists', () => onChange()); c.on('flags', () => onChange()); while (!this.pushStopped) { await c.idle(); } }
      catch (e) { if (!this.pushStopped) console.warn('[imap] idle dropped', (e as Error).message); }
      finally { try { await c.logout(); } catch { /* ignore */ } }
      if (!this.pushStopped) { await new Promise(r => setTimeout(r, delay)); delay = Math.min(delay * 2, 300_000); } } };
    void loop();
  }
  async stopPush() { this.pushStopped = true; try { await this.pushClient?.logout(); } catch { /* ignore */ } this.pushClient = null; }
}
```

Adapt the fake-client script in the test to whatever call shapes you end up using (`{ uid: '5' }` etc.) — the test pins the *behavior* (add `\Seen`, remove `\Flagged`, move to Trash, append to Sent), not exact argument objects; edit both together.

- [ ] **Step 5: Run** → both test files pass; `npm run lint` clean.

- [ ] **Step 6: Commit** — `git add server/mail/providers/imap.ts server/mail/providers/imap.test.ts server/mail/providers/mimeBuild.ts server/mail/providers/mimeBuild.test.ts server/types.d.ts && git commit -m "feat(mail): IMAP/SMTP provider with IDLE push"`

---
### Task 3: Gmail provider

**Files:**
- Create: `server/mail/providers/google.ts`, fixtures `server/mail/providers/__fixtures__/gmail-*.json`
- Test: `server/mail/providers/google.test.ts`

**Interfaces:**
- `googleRefresh(env, refreshToken, fetchFn): Promise<{ accessToken; expiresInSec; refreshToken? }>` — POST `https://oauth2.googleapis.com/token` form-encoded `{ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }`. Non-2xx → throw `Error(body.error + ': ' + body.error_description)` (TokenSource maps `invalid_grant`).
- `class GmailProvider implements MailProvider { constructor(tokens: TokenSource, opts: { fetch: typeof fetch; emailAddress: string }) }` — talks to `https://gmail.googleapis.com/gmail/v1/users/me/...` via `fetch` with `Authorization: Bearer` (no `googleapis` SDK at runtime → fewer moving parts; the SDK is only used by `oauth.ts` for the consent URL/code exchange). 401 → `tokens.invalidate()` + one retry, then `AuthExpiredError`. 429/503 → `RateLimitedError`.
- Sync state `{ historyId: string }`. `backfill`: `GET messages?q=after:<unix seconds>&maxResults=100&pageToken` then `POST batch`-free approach: `GET messages/{id}?format=metadata&metadataHeaders=From,To,Cc,Bcc,Subject,Date,Message-ID,In-Reply-To,References` in groups of 10 concurrent; attachments come from `format=full`'s `payload` only on `getBody` — for the index, `hasAttachments` is derived from `format=metadata`'s lack of parts, so do `format=full` **without** body data? Not possible; instead use `format=metadata` for envelope and set `attachments: []` + `hasAttachments` from the label-free heuristic `sizeEstimate > 20_000`? No — correctness matters: use `format=full` but only read `payload.parts[].filename/mimeType/body.size/body.attachmentId/headers Content-ID` and `snippet`, discarding body data (Gmail returns the body base64 inside; cost is bandwidth only and messages are fetched once). Keep concurrency at 5.
- `incremental`: `GET history?startHistoryId=&historyTypes=messageAdded,messageDeleted,labelAdded,labelRemoved`; collect touched ids → refetch each (`format=full` as above) → `upserts`; `messageDeleted` → `deletes`. 404 on history → return `{ upserts: [], deletes: [], state: { historyId: null }, reset: true }` and the engine's `runIncremental` must treat `state.historyId === null` by running `runBackfill` (add this branch in Plan 1 engine: if provider returns `reset: true`, call `runBackfill`). Store the profile's current `historyId` at the end of backfill (`GET profile`).
- Folders = labels: `GET labels`; role map `INBOX→inbox, SENT→sent, DRAFT→drafts, TRASH→trash, SPAM→spam, STARRED→starred`; hide `CATEGORY_*`, `CHAT`, `UNREAD`, `IMPORTANT` from the folder list; user labels (type `user`) shown. `archive` = `messages.batchModify removeLabelIds:['INBOX']`; `trash` = `messages/{id}/trash`; `move(ids, labelId)` = batchModify add label + remove INBOX; flags: `UNREAD`/`STARRED` labels via batchModify.
- Envelope: `providerThreadId = threadId`, `isRead = !labelIds.includes('UNREAD')`, `isStarred = labelIds.includes('STARRED')`, `isDraft = labelIds.includes('DRAFT')`, `folderProviderIds = labelIds` (engine maps unknown ones away), `date` from `internalDate` ms.
- `getBody`: `format=full` → walk parts: first `text/html` and `text/plain` (base64url decode), attachments (`body.attachmentId`) → `attId = attachmentId`, `contentId` from part header `Content-ID`.
- `getAttachment`: `GET messages/{id}/attachments/{attId}` → base64url `data` → `Readable.from(Buffer)`; name/mime looked up from a cached `getBody` part list (call `getBody` first if not cached).
- `send`: `POST messages/send` `{ raw: base64url(buildRawMime(msg)), threadId? }` — Gmail threads by headers; returns `{ id, threadId }`. Drafts: `POST drafts` `{ message: { raw } }` / `PUT drafts/{id}` / `DELETE drafts/{id}`; `saveDraft` returns the draft's `message.id`? No — return the **draft id** as `providerMessageId` prefixed `draft:` so `deleteDraft` can route to `DELETE drafts/{id}`.
- `search(q, { before, limit })`: `GET messages?q=<q> before:<yyyy/mm/dd>&maxResults=limit` → refetch envelopes.

- [ ] **Step 1: Record fixtures**

Create JSON fixtures by hand from the Gmail API reference shapes (no network): `gmail-labels.json` (INBOX, SENT, DRAFT, TRASH, SPAM, STARRED, UNREAD, CATEGORY_PROMOTIONS, Label_12 "Bids"), `gmail-message-full.json` (one message with html+text parts and a PDF attachment part `attachmentId: "ANGjdJ..."`, `Content-ID` on an inline png), `gmail-history.json` (`messagesAdded` for id `m2`, `messagesDeleted` for `m0`, `historyId: "9999"`), `gmail-attachment.json` (`{ size: 4, data: "JVBERg" }`), `gmail-profile.json` (`{ emailAddress, historyId: "1000" }`), `gmail-list.json` (`{ messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: undefined }`).

- [ ] **Step 2: Write the failing test**

```ts
// server/mail/providers/google.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs'; import path from 'path';
import { GmailProvider, googleRefresh } from './google';
import { TokenSource } from './tokenSource';
import { AuthExpiredError, RateLimitedError } from './types';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', n), 'utf8'));
function fakeFetch(routes: Array<[RegExp, (url: string, init: any) => any]>) {
  const calls: Array<{ url: string; init: any }> = [];
  const f = async (url: string, init: any = {}) => { calls.push({ url, init }); for (const [re, h] of routes) if (re.test(url)) { const r = h(url, init); return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } }); } return new Response('{"error":{"message":"not found"}}', { status: 404 }); };
  return Object.assign(f as unknown as typeof fetch, { calls });
}
const tokens = () => new TokenSource({ refreshToken: 'r', refresh: async () => ({ accessToken: 'AT', expiresInSec: 3600 }) });

describe('GmailProvider', () => {
  it('lists labels as folders with roles, hiding system categories', async () => {
    const f = fakeFetch([[/\/labels$/, () => fx('gmail-labels.json')]]);
    const p = new GmailProvider(tokens(), { fetch: f, emailAddress: 'me@x' });
    const folders = await p.listFolders();
    expect(folders.find(x => x.providerId === 'INBOX')!.role).toBe('inbox'); expect(folders.find(x => x.providerId === 'Label_12')!.name).toBe('Bids');
    expect(folders.some(x => x.providerId.startsWith('CATEGORY_'))).toBe(false); expect(folders.some(x => x.providerId === 'UNREAD')).toBe(false);
    expect(f.calls[0].init.headers.Authorization).toBe('Bearer AT');
  });
  it('backfill lists after the since date and maps full messages to envelopes', async () => {
    const f = fakeFetch([[/\/messages\?/, url => { expect(url).toMatch(/q=after%3A\d+/); return fx('gmail-list.json'); }], [/\/messages\/m1\?/, () => fx('gmail-message-full.json')], [/\/profile$/, () => fx('gmail-profile.json')]]);
    const p = new GmailProvider(tokens(), { fetch: f, emailAddress: 'me@x' });
    const r = await p.backfill({ since: new Date('2026-03-01') });
    const m = r.messages[0];
    expect(m).toMatchObject({ providerMessageId: 'm1', providerThreadId: 't1', isRead: false, isStarred: true, folderProviderIds: expect.arrayContaining(['INBOX']) });
    expect(m.messageIdHeader).toBe(fx('gmail-message-full.json').payload.headers.find((h: any) => h.name === 'Message-ID').value.replace(/^<|>$/g, '').toLowerCase());
    expect(m.attachments.map(a => a.name)).toContain('COR-4.pdf'); expect(m.attachments.find(a => a.contentId)).toBeTruthy();
    expect(r.done).toBe(true);
  });
  it('incremental applies history and returns reset on 404', async () => {
    const f = fakeFetch([[/\/history\?/, () => fx('gmail-history.json')], [/\/messages\/m2\?/, () => ({ ...fx('gmail-message-full.json'), id: 'm2' })]]);
    const p = new GmailProvider(tokens(), { fetch: f, emailAddress: 'me@x' });
    const r = await p.incremental({ historyId: '1000' });
    expect(r.upserts.map(u => u.providerMessageId)).toEqual(['m2']); expect(r.deletes).toEqual(['m0']); expect(r.state).toEqual({ historyId: '9999' });
    const gone = fakeFetch([[/\/history\?/, () => new Response('{}', { status: 404 })]]);
    const r2 = await new GmailProvider(tokens(), { fetch: gone, emailAddress: 'me@x' }).incremental({ historyId: '1' });
    expect((r2 as any).reset).toBe(true);
  });
  it('getBody decodes html/text; getAttachment streams decoded bytes', async () => {
    const f = fakeFetch([[/\/messages\/m1\?/, () => fx('gmail-message-full.json')], [/\/attachments\//, () => fx('gmail-attachment.json')]]);
    const p = new GmailProvider(tokens(), { fetch: f, emailAddress: 'me@x' });
    const b = await p.getBody('m1'); expect(b.html).toContain('<'); expect(b.text).toBeTruthy();
    const a = await p.getAttachment('m1', b.attachments[0].attId); const chunks: Buffer[] = []; for await (const c of a.stream as any) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('%PDF'); expect(a.mime).toBe('application/pdf');
  });
  it('flags/archive/trash/move use batchModify and trash endpoints', async () => {
    const f = fakeFetch([[/batchModify$/, () => ({})], [/\/trash$/, () => ({})]]);
    const p = new GmailProvider(tokens(), { fetch: f, emailAddress: 'me@x' });
    await p.setFlags(['m1'], { read: true, starred: true }); await p.archive(['m1']); await p.trash(['m1']); await p.move(['m1'], 'Label_12');
    const bodies = f.calls.filter(c => /batchModify/.test(c.url)).map(c => JSON.parse(c.init.body));
    expect(bodies[0]).toMatchObject({ ids: ['m1'], removeLabelIds: ['UNREAD'], addLabelIds: ['STARRED'] });
    expect(bodies[1]).toMatchObject({ removeLabelIds: ['INBOX'] }); expect(bodies[2]).toMatchObject({ addLabelIds: ['Label_12'], removeLabelIds: ['INBOX'] });
    expect(f.calls.some(c => /\/m1\/trash$/.test(c.url))).toBe(true);
  });
  it('send posts base64url raw and returns ids; drafts round-trip', async () => {
    const f = fakeFetch([[/\/messages\/send$/, () => ({ id: 's1', threadId: 't9' })], [/\/drafts$/, () => ({ id: 'd1', message: { id: 'dm1' } })], [/\/drafts\/d1$/, (_u, init) => (init.method === 'DELETE' ? new Response('', { status: 204 }) : { id: 'd1' })]]);
    const p = new GmailProvider(tokens(), { fetch: f, emailAddress: 'me@x' });
    const msg = { from: { addr: 'me@x' }, to: [{ addr: 'y@z' }], cc: [], bcc: [], subject: 's', html: '<p>h</p>', text: 'h', attachments: [], messageIdHeader: 'mid@x' };
    expect(await p.send(msg)).toEqual({ providerMessageId: 's1', providerThreadId: 't9' });
    expect(JSON.parse(f.calls[0].init.body).raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const d = await p.saveDraft(msg); expect(d.providerMessageId).toBe('draft:d1'); await p.saveDraft(msg, 'draft:d1'); await p.deleteDraft('draft:d1');
  });
  it('401 → invalidate + retry once, then AuthExpiredError; 429 → RateLimitedError', async () => {
    let n = 0; const f = fakeFetch([[/\/labels$/, () => new Response('{}', { status: n++ < 5 ? 401 : 200 })]]);
    await expect(new GmailProvider(tokens(), { fetch: f, emailAddress: 'me@x' }).listFolders()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(n).toBe(2);
    const r = fakeFetch([[/\/labels$/, () => new Response('{}', { status: 429 })]]);
    await expect(new GmailProvider(tokens(), { fetch: r, emailAddress: 'me@x' }).listFolders()).rejects.toBeInstanceOf(RateLimitedError);
  });
  it('googleRefresh posts the form and surfaces invalid_grant', async () => {
    const ok = fakeFetch([[/oauth2\.googleapis\.com\/token/, () => ({ access_token: 'A', expires_in: 3599 })]]);
    expect(await googleRefresh({ GOOGLE_OAUTH_CLIENT_ID: 'i', GOOGLE_OAUTH_CLIENT_SECRET: 's' } as any, 'rt', ok)).toEqual({ accessToken: 'A', expiresInSec: 3599, refreshToken: undefined });
    expect(ok.calls[0].init.body).toContain('grant_type=refresh_token');
    const bad = fakeFetch([[/token/, () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), { status: 400 })]]);
    await expect(googleRefresh({ GOOGLE_OAUTH_CLIENT_ID: 'i', GOOGLE_OAUTH_CLIENT_SECRET: 's' } as any, 'rt', bad)).rejects.toThrow(/invalid_grant/);
  });
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement `google.ts`**

Write the class per the interface list. Shared request helper:

```ts
private async api<T>(path: string, init: RequestInit & { query?: Record<string, string | number | undefined> } = {}, retry = true): Promise<T> {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/' + path.replace(/^\//, ''));
  Object.entries(init.query ?? {}).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, String(v)));
  const res = await this.opts.fetch(url.toString(), { ...init, headers: { ...(init.headers as any), Authorization: `Bearer ${await this.tokens.get()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 401) { this.tokens.invalidate(); if (retry) return this.api<T>(path, init, false); throw new AuthExpiredError('Gmail rejected the access token'); }
  if (res.status === 429 || res.status === 503) throw new RateLimitedError(`Gmail ${res.status}`);
  if (res.status === 404) throw new ProviderNotFoundError(path);
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? (undefined as T) : res.json();
}
```

Base64url helpers: `const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')`, `const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')`.

Message → Envelope: headers via `const h = (n: string) => payload.headers?.find(x => x.name.toLowerCase() === n.toLowerCase())?.value`; addresses via `parseAddressList` from `../mime`; references via `(h('References') || '').match(/<[^>]+>/g)`; parts walk collecting attachments where `body.attachmentId` is set (name = `filename`, mime = `mimeType`, size = `body.size`, contentId = part header `Content-ID` stripped of `<>`).

`googleRefresh`:

```ts
export async function googleRefresh(env: NodeJS.ProcessEnv, refreshToken: string, fetchFn: typeof fetch) {
  const res = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(), signal: AbortSignal.timeout(30_000) });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${body.error || res.status}: ${body.error_description || ''}`);
  return { accessToken: body.access_token as string, expiresInSec: Number(body.expires_in) || 3600, refreshToken: body.refresh_token as string | undefined };
}
```

- [ ] **Step 5: Engine reset branch (Plan 1 engine)**

In `server/mail/sync/engine.ts` `runIncremental`, after `const r = await provider.incremental(...)`: `if ((r as any).reset) { accounts.updateAccount(ctx.db, account.id, { syncState: null }); await runBackfill(ctx, accounts.getAccountAny(ctx.db, account.id)!, provider); return; }`. Add an engine test: a provider whose `incremental` returns `{ reset: true, ... }` triggers a backfill (spy on `backfill`).

- [ ] **Step 6: Run** → `google.test.ts` + `engine.test.ts` pass.

- [ ] **Step 7: Commit** — `git add server/mail/providers/google.ts server/mail/providers/google.test.ts server/mail/providers/__fixtures__ server/mail/sync/engine.ts server/mail/sync/engine.test.ts && git commit -m "feat(mail): Gmail API provider with history sync"`

---

### Task 4: Microsoft Graph provider

**Files:**
- Create: `server/mail/providers/microsoft.ts`, fixtures `server/mail/providers/__fixtures__/graph-*.json`
- Test: `server/mail/providers/microsoft.test.ts`

**Interfaces:**
- `microsoftRefresh(env, refreshToken, fetchFn)` — POST `https://login.microsoftonline.com/${env.MS_OAUTH_TENANT || 'common'}/oauth2/v2.0/token` form `{ client_id, client_secret, refresh_token, grant_type: 'refresh_token', scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access' }`; Microsoft rotates refresh tokens → return `refresh_token` so `TokenSource.onRotate` persists it.
- `class GraphProvider implements MailProvider { constructor(tokens: TokenSource, opts: { fetch: typeof fetch }) }` — base `https://graph.microsoft.com/v1.0/me/`; same `api()` helper pattern as Gmail (401 retry-once, 429 → `RateLimitedError` honoring `Retry-After`).
- Folders: `GET mailFolders?$top=200&$select=id,displayName,wellKnownName,unreadItemCount,totalItemCount` (+ `childFolders` one level via `GET mailFolders/{id}/childFolders`); roles from `wellKnownName`: `inbox, sentitems→sent, drafts, deleteditems→trash, junkemail→spam, archive`.
- Sync state `{ deltaLinks: { [folderId]: string } }`. `backfill`: for each folder except junk/deleted, `GET mailFolders/{id}/messages/delta?$select=<envelope fields>&$filter=receivedDateTime ge <since ISO>` (delta supports this filter on the initial call) following `@odata.nextLink` until `@odata.deltaLink` → store. `incremental`: for each stored `deltaLink` GET it; entries with `@removed` → `deletes`; others → `upserts`; update links. Folders not yet in state (created later) get an initial delta on the next backfill-like pass: treat missing folder state by calling the filtered delta with `since = now`.
- Envelope select: `id,conversationId,internetMessageId,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,isDraft,flag,hasAttachments,from,toRecipients,ccRecipients,bccRecipients,parentFolderId,internetMessageHeaders` — `In-Reply-To`/`References` from `internetMessageHeaders` (Graph returns them only when `$select`ed and only for messages that have them; missing → `[]`). `isStarred = flag?.flagStatus === 'flagged'`. `folderProviderIds = [parentFolderId]`. Attachments metadata: when `hasAttachments`, `GET messages/{id}/attachments?$select=id,name,contentType,size,isInline,contentId` (batched 5-concurrent during backfill; acceptable cost).
- `getBody`: `GET messages/{id}?$select=body,uniqueBody` with header `Prefer: outlook.body-content-type="html"` → `{ html: body.content }` (and `text` via `htmlToText`); attachments list as above.
- `getAttachment`: `GET messages/{id}/attachments/{attId}/$value` → stream `res.body` (Web stream → `Readable.fromWeb`); name/mime from the metadata call.
- Flags: `PATCH messages/{id}` `{ isRead }` / `{ flag: { flagStatus: 'flagged' | 'notFlagged' } }`. `move(ids, folderId)`: `POST messages/{id}/move { destinationId }`; `archive` → `destinationId: 'archive'`; `trash` → `'deleteditems'`.
- `send`: `POST sendMail { message: { subject, body: { contentType: 'HTML', content }, toRecipients, ccRecipients, bccRecipients, attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name, contentType, contentBytes(base64), contentId?, isInline }], internetMessageHeaders: [{ name: 'X-Frugal-Message-Id', value }] , ...(inReplyTo ? { internetMessageHeaders +In-Reply-To/References } : {}) }, saveToSentItems: true }`. Graph forbids setting `Message-ID` directly, and custom headers must start with `x-` — so `In-Reply-To`/`References` **cannot** be set via `sendMail`. Use the two-step draft flow instead: `POST messages` (creates draft with `internetMessageId`? not settable either) … Resolution: for replies use `POST messages/{lastProviderMessageId}/createReply` (Graph sets threading headers itself), then `PATCH` the draft with body/recipients/subject, add attachments (`POST messages/{id}/attachments`, ≤3 MB each; larger via upload session — cap at 3 MB per attachment for Graph replies and surface a clear error), then `POST messages/{id}/send`. For new messages use `sendMail`. Return `providerMessageId` = the sent message id found by `GET messages?$filter=internetMessageId eq '<id>'`? Graph doesn't return the sent id from `sendMail`; instead, after send, query `GET mailFolders/sentitems/messages?$top=1&$orderby=sentDateTime desc&$select=id,internetMessageId` and match subject+recipient within 60 s; fall back to a synthetic `sent:<messageIdHeader>` (the next delta sync will upsert the real row and the engine dedupes by `messageIdHeader` — add that dedupe: in `upsertEnvelopes`, if an incoming envelope's `messageIdHeader` matches an existing row whose `providerMessageId` starts with `sent:`, update that row's `providerMessageId` instead of inserting).
  The `OutgoingMessage.messageIdHeader` the app generated is therefore **not** what Graph puts on the wire for M365; the engine must read back the real `internetMessageId` from the sent row. Implement: `send()` returns `{ providerMessageId, providerThreadId: conversationId, messageIdHeader?: string }` — extend the contract's return type with optional `messageIdHeader`, and `sendService` uses it when present for the indexed envelope and for `threadKey` derivation.
- Drafts: `POST messages` `{ subject, body, toRecipients… }` → `id`; update `PATCH messages/{id}`; delete `DELETE messages/{id}`.
- `search`: `GET messages?$search="<q>"&$top=<limit>&$select=<envelope>` (+ client-side `before` filter).
- `startPush(onChange)`: handled by `push.ts` (Task 6) — `GraphProvider` exposes `createSubscription(notificationUrl, clientState): Promise<{ id; expirationDateTime }>` and `renewSubscription(id)`; `startPush` is a no-op here.

- [ ] **Step 1: Fixtures** — `graph-folders.json`, `graph-delta-initial.json` (2 messages + `@odata.deltaLink`), `graph-delta-incremental.json` (1 updated, 1 `@removed`, new deltaLink), `graph-message-body.json`, `graph-attachments.json`, `graph-sentitems.json`.

- [ ] **Step 2: Write the failing test** — mirror the Gmail test structure: folders/roles; backfill via delta with `$filter=receivedDateTime ge`; incremental applies `@removed`; getBody uses `Prefer` header; getAttachment streams `$value`; setFlags → PATCH bodies; move/archive/trash → `/move` with `destinationId`; `send` new → `sendMail` with `saveToSentItems: true` and returns the sent id from `sentitems` lookup; `send` reply → `createReply` → PATCH → attachments → `/send`; drafts CRUD; 401/429 handling; `microsoftRefresh` returns rotated `refresh_token`.

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** per the interface list (same `api()` shape as Gmail with base URL swapped; `Retry-After` parsed for `RateLimitedError.retryAfterMs`).

- [ ] **Step 5: `sendService` + engine adjustments** — accept `messageIdHeader` from `provider.send()`; dedupe `sent:` placeholder rows by `messageIdHeader` in `upsertEnvelopes`. Add tests: sendService uses the returned header; engine replaces a `sent:x` row when the real envelope arrives.

- [ ] **Step 6: Run** → `microsoft.test.ts`, `sendService.test.ts`, `engine.test.ts`, `index.test.ts` (Task 1) all pass; `npm run lint` clean.

- [ ] **Step 7: Commit** — `git add server/mail/providers/microsoft.ts server/mail/providers/microsoft.test.ts server/mail/providers/__fixtures__ server/mail/sendService.ts server/mail/sync/engine.ts server/mail/providers/types.ts && git commit -m "feat(mail): Microsoft Graph provider with delta sync"`

---

### Task 5: OAuth start/callback

**Files:**
- Create: `server/mail/oauth.ts`
- Modify: `server/mail/routes.ts` (replace the 501 stub; add callback route)
- Test: `server/mail/oauth.test.ts`

**Interfaces:**
- `buildAuthUrl(provider: 'google'|'microsoft', env, publicUrl, state: string, codeChallenge: string): string`
  - Google: `https://accounts.google.com/o/oauth2/v2/auth?client_id&redirect_uri&response_type=code&scope=https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send openid email&access_type=offline&prompt=consent&state&code_challenge&code_challenge_method=S256`
  - Microsoft: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?client_id&redirect_uri&response_type=code&response_mode=query&scope=https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access openid email&state&code_challenge&code_challenge_method=S256`
- `exchangeCode(provider, env, publicUrl, code, codeVerifier, fetchFn): Promise<{ refreshToken: string; accessToken: string; email: string; name?: string }>` — token POST (`grant_type=authorization_code`, `code_verifier`) then identity: Google `GET https://openidconnect.googleapis.com/v1/userinfo` (`email`, `name`); Microsoft `GET https://graph.microsoft.com/v1.0/me` (`mail || userPrincipalName`, `displayName`). Missing `refresh_token` → throw `Error('No refresh token returned — remove the app from your account\'s third-party access and try again')`.
- `signState(jwtSecret, payload: { userId; provider; verifier }): string` (HS256, `exp` 10 min) / `verifyState(jwtSecret, state): payload` — the PKCE verifier rides inside the signed state so no server-side session is needed (state is only ever seen by the provider and the user's own browser; it's signed, not encrypted — acceptable because the verifier alone is useless without the client secret).
- Routes: `GET /api/mail/oauth/:provider/start` → 302 to auth URL (query `?token=` accepted like attachment routes, because the browser navigates, it can't send a header — use `authOrQueryToken`). `GET /api/mail/oauth/:provider/callback?code&state` (no auth; identity comes from the state) → exchange → `createAccount` (or `updateAuth` + status `ok` if an account for `(userId, provider, email)` exists — reconnect) → `scheduler.startAccount` → 302 `/settings?tab=mail&connected=<id>`; errors → 302 `/settings?tab=mail&error=<encoded message>`.
- `MailRouteDeps` gains `jwtSecret: string`.

- [ ] **Step 1: Write the failing test**

```ts
// server/mail/oauth.test.ts
import { describe, it, expect } from 'vitest';
import { buildAuthUrl, exchangeCode, signState, verifyState } from './oauth';
const env: any = { GOOGLE_OAUTH_CLIENT_ID: 'gid', GOOGLE_OAUTH_CLIENT_SECRET: 'gs', MS_OAUTH_CLIENT_ID: 'mid', MS_OAUTH_CLIENT_SECRET: 'ms', MS_OAUTH_TENANT: 'tenant1' };
describe('oauth', () => {
  it('builds provider auth URLs with PKCE and exact redirect URIs', () => {
    const g = new URL(buildAuthUrl('google', env, 'https://app.test', 'st', 'ch'));
    expect(g.origin + g.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth'); expect(g.searchParams.get('redirect_uri')).toBe('https://app.test/api/mail/oauth/google/callback');
    expect(g.searchParams.get('scope')).toContain('gmail.modify'); expect(g.searchParams.get('access_type')).toBe('offline'); expect(g.searchParams.get('code_challenge_method')).toBe('S256');
    const m = new URL(buildAuthUrl('microsoft', env, 'https://app.test/', 'st', 'ch'));
    expect(m.pathname).toBe('/tenant1/oauth2/v2.0/authorize'); expect(m.searchParams.get('redirect_uri')).toBe('https://app.test/api/mail/oauth/microsoft/callback'); expect(m.searchParams.get('scope')).toContain('offline_access');
  });
  it('state round-trips and expires', () => {
    const s = signState('secret', { userId: 'u1', provider: 'google', verifier: 'v' });
    expect(verifyState('secret', s)).toMatchObject({ userId: 'u1', provider: 'google', verifier: 'v' });
    expect(() => verifyState('other', s)).toThrow();
  });
  it('exchangeCode posts code+verifier and fetches identity', async () => {
    const calls: any[] = []; const f: any = async (url: string, init: any) => { calls.push({ url, init });
      if (/token/.test(url)) return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ email: 'me@bigbear.com', name: 'Nate' }), { status: 200 }); };
    const r = await exchangeCode('google', env, 'https://app.test', 'code1', 'verif', f);
    expect(r).toEqual({ refreshToken: 'R', accessToken: 'A', email: 'me@bigbear.com', name: 'Nate' });
    expect(calls[0].init.body).toContain('code_verifier=verif'); expect(calls[0].init.body).toContain('redirect_uri=https%3A%2F%2Fapp.test%2Fapi%2Fmail%2Foauth%2Fgoogle%2Fcallback');
    const noRt: any = async () => new Response(JSON.stringify({ access_token: 'A' }), { status: 200 });
    await expect(exchangeCode('google', env, 'https://app.test', 'c', 'v', noRt)).rejects.toThrow(/refresh token/);
  });
});
```

Plus route tests appended to `server/mail/routes.test.ts`: `GET /api/mail/oauth/google/start?token=tok` → 302 whose `Location` contains `state=`; `GET /api/mail/oauth/google/callback?code=x&state=<signed>` with `deps.oauthExchange` stubbed (add `oauthExchange?: typeof exchangeCode` to `MailRouteDeps` for injection) → creates the account, redirects to `/settings?tab=mail&connected=<id>`; second callback for the same email updates auth instead of duplicating; bad state → redirect with `error=`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `oauth.ts`** (PKCE: `verifier = base64url(randomBytes(32))`, `challenge = base64url(sha256(verifier))`; `jsonwebtoken` for state) and the two routes in `routes.ts`. **Step 4: Run** → pass. **Step 5: Commit** — `git commit -am "feat(mail): Google/Microsoft OAuth connect flow"`

---

### Task 6: Push — Graph webhook + subscription renewal; IMAP IDLE hook-up

**Files:**
- Create: `server/mail/push.ts`
- Modify: `server/mail/sync/scheduler.ts` (call `provider.startPush?.(...)` / `stopPush?.()`; renewal timer), `server/mail/routes.ts` (`POST /api/mail/ms/webhook`)
- Test: `server/mail/push.test.ts`, scheduler test additions

**Interfaces:**
- `push.ts`: `ensureGraphSubscription(ctx, account, provider: GraphProvider, publicUrl): Promise<void>` — reads `syncState.subscriptionId/subscriptionExpires`; creates (`resource: 'me/messages'`, `changeType: 'created,updated,deleted'`, `notificationUrl: publicUrl + '/api/mail/ms/webhook'`, `clientState: getWebhookSecret(db)`, `expirationDateTime: now + 2 days`) or renews when < 12 h left; persists ids into `syncState`. `getWebhookSecret(db)`: `settings` row `mail.webhookSecret`, generated (`randomBytes(24).hex`) on first use — note `SETTINGS_PRIVATE_PREFIXES` in `server.ts:441` must gain `'mail.'`.
  `handleGraphWebhook(ctx, body, clientStateExpected): string[]` — validates each notification's `clientState`, maps `subscriptionId` → `accountId` (lookup `mail_accounts` where `syncState` LIKE `%"subscriptionId":"<id>"%`), returns account ids to poke.
- Route: `POST /api/mail/ms/webhook` — **no auth**; if `?validationToken=` present → respond `200 text/plain` with the token (Graph handshake); else parse JSON, `handleGraphWebhook`, `scheduler.pokeAccount(id)` for each, respond `202`. Always responds within 3 s (poke is fire-and-forget).
- Scheduler: after `startAccount` → `void provider.startPush?.(() => this.pokeAccount(id))`; in `stopAccount` → `void provider.stopPush?.()`. Every tick for a `microsoft` account with `publicUrl` set → `ensureGraphSubscription` (cheap when not due). `MailScheduler` constructor gets `publicUrl?: string | null` in opts.

- [ ] **Step 1: Tests** — `push.test.ts`: `handleGraphWebhook` ignores mismatched clientState, maps subscription → account; `ensureGraphSubscription` creates when absent and renews when <12 h (provider stubbed with `createSubscription/renewSubscription` spies). Routes: webhook handshake echoes `validationToken` as `text/plain`; POST with notifications calls `scheduler.pokeAccount` (spy). Scheduler: `startAccount` calls `startPush` with a callback that triggers an incremental.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → pass. **Step 5: Commit** — `git commit -am "feat(mail): Graph change notifications + IMAP IDLE push wired into the scheduler"`

---

### Task 7: Runbook + wiring check + push

**Files:**
- Create: `docs/mail-setup.md`
- Modify: `server.ts` (`SETTINGS_PRIVATE_PREFIXES` += `'mail.'`; `MailScheduler` gets `publicUrl`; `registerMailRoutes` gets `jwtSecret: JWT_SECRET`), `docs/MIGRATION-CUTOVER.md` (mention `data/mail.key` must travel with the data dir), `scripts/backup-data.ts` (include `mail.key` if the backup enumerates files explicitly — check).

- [ ] **Step 1: Write `docs/mail-setup.md`** with exactly the spec §6 steps for Google (Internal consent screen, Gmail API, Web client, redirect URI, scopes) and Microsoft (app registration, redirect URI, delegated permissions + admin consent, secret), the env var table (`APP_PUBLIC_URL`, `MAIL_SECRET_KEY`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `MS_OAUTH_CLIENT_ID/SECRET/TENANT`), the key-file/backup note, and a troubleshooting section (`auth_error` → Reconnect; webhook validation failing → check `APP_PUBLIC_URL` is reachable from the internet over HTTPS; Gmail "historyId expired" → automatic re-backfill; personal Gmail on an Internal app → unsupported).
- [ ] **Step 2: Manual smoke (record results in the commit message)** — with real env on the testing host: connect Google, connect Microsoft, add IMAP; each reaches `status ok` and lists folders via `GET /api/mail/threads`; send yourself a mail from each and see it indexed within the expected window (Gmail ≤30 s while heartbeat is active, Graph ≤10 s via webhook, IMAP ≤5 s via IDLE).
- [ ] **Step 3:** `npm run lint && npm test` green → `git add -A && git commit -m "docs(mail): provider setup runbook; wire push + oauth into server" && git push origin testing`.

## Plan 2 self-review notes
- §4.1 ✔ Tasks 2–4; §4.2 freshness ✔ (Gmail fast/slow poll from Plan 1 scheduler, Graph webhook Task 6, IMAP IDLE Task 2/6); §4.4 oauth/webhook rows ✔ Tasks 5–6; §6 ✔ Task 7; §7 OAuth/PKCE/state/webhook clientState ✔ Tasks 5–6; §9 provider contract tests ✔.
- Deviation recorded: Microsoft Graph can't set `Message-ID`/`In-Reply-To` on `sendMail`, so replies use `createReply` and the app reads back the real `internetMessageId`; the `MailProvider.send` return gains optional `messageIdHeader`.
