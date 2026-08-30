// server/mail/push.test.ts — Graph change-notification plumbing (spec §4.2 push column)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { MailCrypto } from './crypto';
import * as accounts from './accountStore';
import { FakeMailProvider } from './providers/fake';
import { runIncremental, runBackfill } from './sync/engine';
import {
  getWebhookSecret, handleGraphWebhook, ensureGraphSubscription,
  pickPushState, writeSyncState, MAX_SUBSCRIPTION_MINUTES, type GraphPushApi,
} from './push';
import type { GraphProvider } from './providers/microsoft';
import type { MailContext } from './context';

// Compile-time proof that the real provider still satisfies the narrow surface
// push.ts asks for — `npm run lint` fails if either signature drifts.
const _graphSatisfiesPushApi: GraphPushApi = null as unknown as GraphProvider;
void _graphSatisfiesPushApi;

const crypto = new MailCrypto(Buffer.alloc(32, 9));
let db: Database.Database;
let ctx: MailContext;
let acct: accounts.MailAccountRow;
let provider: FakeMailProvider;

const env = (id: string) => ({
  providerMessageId: id, references: [], from: { addr: 'x@y.com' }, to: [], cc: [], bcc: [],
  subject: 's', snippet: '', date: new Date().toISOString(), isRead: false, isStarred: false, isDraft: false,
  attachments: [], sizeBytes: 1, folderProviderIds: ['INBOX'], messageIdHeader: id + '@y.com',
});
const stateOf = (id: string) => JSON.parse(accounts.getAccountAny(db, id)!.syncState || '{}') as Record<string, unknown>;
const setState = (id: string, state: unknown) => accounts.updateAccount(db, id, { syncState: JSON.stringify(state) });

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-push-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin')`).run();
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'microsoft', emailAddress: 'me@bb.com', auth: { refreshToken: 'r' } });
  provider = new FakeMailProvider();
  provider.seed([env('seeded')]);
  ctx = { db, dataDir: dir, crypto, providerFactory: () => provider, broadcastChange: () => {} };
});

/** A stand-in for GraphProvider's two subscription calls. */
function stubGraph(over: Partial<GraphPushApi> = {}) {
  const create = vi.fn(async (_url: string, _clientState: string, expiration: string) => ({ id: 'sub-new', expirationDateTime: expiration }));
  const renew = vi.fn(async (id: string, expiration: string) => ({ id, expirationDateTime: expiration }));
  return { createSubscription: create, renewSubscription: renew, ...over } as GraphPushApi & { createSubscription: typeof create; renewSubscription: typeof renew };
}

describe('getWebhookSecret', () => {
  it('generates a hex secret on first use and returns the same one afterwards', () => {
    const a = getWebhookSecret(db);
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(getWebhookSecret(db)).toBe(a);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'mail.webhookSecret'").get() as { value: string };
    expect(row.value).toBe(a);
  });
});

describe('handleGraphWebhook', () => {
  beforeEach(() => setState(acct.id, { deltaLinks: { INBOX: 'l' }, subscriptionId: 'sub-1' }));

  it('maps a notification back to the account that owns the subscription', () => {
    const ids = handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-1', clientState: 'secret', resource: 'me/messages' }] }, 'secret');
    expect(ids).toEqual([acct.id]);
  });

  it('ignores a notification whose clientState does not match', () => {
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-1', clientState: 'wrong' }] }, 'secret')).toEqual([]);
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-1' }] }, 'secret')).toEqual([]);
  });

  it('ignores a subscription id no account claims, and never matches a different account', () => {
    const other = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'microsoft', emailAddress: 'other@bb.com', auth: { refreshToken: 'r' } });
    setState(other.id, { deltaLinks: {}, subscriptionId: 'sub-2' });
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-unknown', clientState: 'secret' }] }, 'secret')).toEqual([]);
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-2', clientState: 'secret' }] }, 'secret')).toEqual([other.id]);
  });

  it('does not match on a subscription id that is only a prefix of the stored one', () => {
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-', clientState: 'secret' }] }, 'secret')).toEqual([]);
  });

  it('treats LIKE wildcards in the id as literal text', () => {
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub%', clientState: 'secret' }] }, 'secret')).toEqual([]);
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub_1', clientState: 'secret' }] }, 'secret')).toEqual([]);
  });

  it('returns each account once for a batch that names it repeatedly, and survives junk', () => {
    const body = { value: [
      { subscriptionId: 'sub-1', clientState: 'secret' },
      { subscriptionId: 'sub-1', clientState: 'secret' },
      null, 'nope', { clientState: 'secret' }, { subscriptionId: 42, clientState: 'secret' },
    ] };
    expect(handleGraphWebhook(ctx, body, 'secret')).toEqual([acct.id]);
  });

  it('returns nothing for a body that is not a notification batch', () => {
    expect(handleGraphWebhook(ctx, undefined, 'secret')).toEqual([]);
    expect(handleGraphWebhook(ctx, { value: 'no' }, 'secret')).toEqual([]);
    expect(handleGraphWebhook(ctx, 'garbage', 'secret')).toEqual([]);
  });
});

describe('ensureGraphSubscription', () => {
  it('creates a subscription when the account has none and stores it beside the delta links', async () => {
    setState(acct.id, { deltaLinks: { INBOX: 'link-1' } });
    const g = stubGraph();
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test/', now);
    expect(g.createSubscription).toHaveBeenCalledTimes(1);
    const [url, clientState, expiration] = g.createSubscription.mock.calls[0];
    expect(url).toBe('https://app.test/api/mail/ms/webhook');
    expect(clientState).toBe(getWebhookSecret(db));
    // Graph caps a message subscription at 4230 minutes; ours must sit under it.
    const minutes = (Date.parse(expiration) - now) / 60_000;
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(MAX_SUBSCRIPTION_MINUTES);
    expect(stateOf(acct.id)).toEqual({ deltaLinks: { INBOX: 'link-1' }, subscriptionId: 'sub-new', subscriptionExpires: expiration });
  });

  it('renews when less than 12 hours are left, keeping the same subscription id', async () => {
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    setState(acct.id, { deltaLinks: { INBOX: 'l' }, subscriptionId: 'sub-1', subscriptionExpires: new Date(now + 6 * 3600_000).toISOString() });
    const g = stubGraph();
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test', now);
    expect(g.createSubscription).not.toHaveBeenCalled();
    expect(g.renewSubscription).toHaveBeenCalledTimes(1);
    expect(g.renewSubscription.mock.calls[0][0]).toBe('sub-1');
    const s = stateOf(acct.id);
    expect(s.subscriptionId).toBe('sub-1');
    expect(Date.parse(s.subscriptionExpires as string)).toBeGreaterThan(now + 24 * 3600_000);
    expect(s.deltaLinks).toEqual({ INBOX: 'l' });
  });

  it('does nothing when the subscription still has more than 12 hours left', async () => {
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    const expires = new Date(now + 40 * 3600_000).toISOString();
    setState(acct.id, { subscriptionId: 'sub-1', subscriptionExpires: expires });
    const g = stubGraph();
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test', now);
    expect(g.createSubscription).not.toHaveBeenCalled();
    expect(g.renewSubscription).not.toHaveBeenCalled();
    expect(stateOf(acct.id).subscriptionExpires).toBe(expires);
  });

  it('re-creates the subscription when the renewal is rejected (Graph forgot it)', async () => {
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    setState(acct.id, { subscriptionId: 'gone', subscriptionExpires: new Date(now + 3600_000).toISOString() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = stubGraph({ renewSubscription: vi.fn(async () => { throw new Error('Graph 404'); }) });
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test', now);
    expect(g.createSubscription).toHaveBeenCalledTimes(1);
    expect(stateOf(acct.id).subscriptionId).toBe('sub-new');
    warn.mockRestore();
  });

  it('never rejects when Graph refuses outright, and leaves the stored state alone', async () => {
    setState(acct.id, { deltaLinks: { INBOX: 'l' } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = stubGraph({ createSubscription: vi.fn(async () => { throw new Error('Graph 503'); }) });
    await expect(ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test')).resolves.toBeUndefined();
    expect(stateOf(acct.id)).toEqual({ deltaLinks: { INBOX: 'l' } });
    err.mockRestore();
  });

  it('does nothing without a public URL to point Microsoft at', async () => {
    const g = stubGraph();
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, '');
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, null);
    expect(g.createSubscription).not.toHaveBeenCalled();
  });

  it('merges into the syncState written while the Graph call was in flight, never clobbering it', async () => {
    setState(acct.id, { deltaLinks: { INBOX: 'old' } });
    const g = stubGraph({
      createSubscription: vi.fn(async (_u: string, _c: string, exp: string) => {
        setState(acct.id, { deltaLinks: { INBOX: 'fresh-from-a-poll' } });   // a tick finished mid-flight
        return { id: 'sub-new', expirationDateTime: exp };
      }),
    });
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test');
    const s = stateOf(acct.id);
    expect(s.deltaLinks).toEqual({ INBOX: 'fresh-from-a-poll' });
    expect(s.subscriptionId).toBe('sub-new');
  });
});

describe('push state survives the sync engine', () => {
  it('pickPushState reads only the push keys, and tolerates broken JSON', () => {
    expect(pickPushState('{"deltaLinks":{},"subscriptionId":"s","subscriptionExpires":"2026-01-01T00:00:00.000Z"}'))
      .toEqual({ subscriptionId: 's', subscriptionExpires: '2026-01-01T00:00:00.000Z' });
    expect(pickPushState(null)).toEqual({});
    expect(pickPushState('not json')).toEqual({});
  });

  it('writeSyncState replaces the provider state but carries the subscription across', () => {
    setState(acct.id, { deltaLinks: { A: '1' }, subscriptionId: 'sub-1', subscriptionExpires: 'x' });
    writeSyncState(db, acct.id, { deltaLinks: { B: '2' } });
    expect(stateOf(acct.id)).toEqual({ deltaLinks: { B: '2' }, subscriptionId: 'sub-1', subscriptionExpires: 'x' });
  });

  it('an incremental poll does not orphan the subscription the scheduler created', async () => {
    await runBackfill(ctx, accounts.getAccountAny(db, acct.id)!, provider);
    writeSyncState(db, acct.id, { ...stateOf(acct.id), subscriptionId: 'sub-1', subscriptionExpires: 'later' });
    provider.injectInbound(env('new-one'));
    await runIncremental(ctx, accounts.getAccountAny(db, acct.id)!, provider);
    const s = stateOf(acct.id);
    expect(s.subscriptionId).toBe('sub-1');
    expect(s.cursor).toBe(1);   // the provider's own state was still refreshed
  });

  it('a load-older backfill does not orphan the subscription either', async () => {
    await runBackfill(ctx, accounts.getAccountAny(db, acct.id)!, provider);
    writeSyncState(db, acct.id, { ...stateOf(acct.id), subscriptionId: 'sub-1' });
    await runBackfill(ctx, accounts.getAccountAny(db, acct.id)!, provider, new Date(0));
    expect(stateOf(acct.id).subscriptionId).toBe('sub-1');
  });
});
