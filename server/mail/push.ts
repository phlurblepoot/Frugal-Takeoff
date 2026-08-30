// server/mail/push.ts  (spec §4.2 — the "push" column of the freshness table)
//
// Two providers can tell us about new mail instead of waiting for the poll:
//   * IMAP holds a connection in IDLE — the provider owns that socket, the
//     scheduler only calls startPush/stopPush.
//   * Microsoft Graph posts a change notification to a public URL. There is no
//     socket to hold, so the moving parts live here: the shared webhook secret,
//     the subscription's create/renew lifecycle, and the mapping from an
//     incoming notification back to the account that owns the subscription.
import { randomBytes, timingSafeEqual } from 'crypto';
import type Database from 'better-sqlite3';
import type { MailContext } from './context';
import * as accounts from './accountStore';
import type { MailAccountRow } from './accountStore';
import type { SyncState } from './providers/types';

/** Path Microsoft POSTs to; also what `GET /api/mail/setup-info` shows an admin. */
export const WEBHOOK_PATH = '/api/mail/ms/webhook';
/** Graph refuses a `/me/messages` subscription longer than 4230 minutes (~3 days). */
export const MAX_SUBSCRIPTION_MINUTES = 4230;
/** Two days, comfortably inside the cap and well over one renewal cycle. */
const SUBSCRIPTION_TTL_MS = 2 * 24 * 3600_000;
/** Renew once the remaining life drops below this — several slow polls' worth of slack. */
const RENEW_WHEN_LEFT_MS = 12 * 3600_000;
const SECRET_KEY = 'mail.webhookSecret';

/** The slice of GraphProvider this module borrows. Kept structural so the
 *  scheduler can duck-type a provider and tests need no Graph client. */
export interface GraphPushApi {
  createSubscription(notificationUrl: string, clientState: string, expirationIso: string): Promise<{ id: string; expirationDateTime: string }>;
  renewSubscription(id: string, expirationIso: string): Promise<{ id: string; expirationDateTime: string }>;
}

/** True when this provider instance can carry a Graph subscription. */
export function hasGraphPushApi(p: unknown): p is GraphPushApi {
  const c = p as Partial<GraphPushApi> | null;
  return typeof c?.createSubscription === 'function' && typeof c?.renewSubscription === 'function';
}

/** The `clientState` every notification must echo back. Generated once and kept
 *  in `settings` under a `mail.` key, which `/api/settings` withholds. */
export function getWebhookSecret(db: Database.Database): string {
  const read = () => (db.prepare('SELECT value FROM settings WHERE key = ?').get(SECRET_KEY) as { value: string } | undefined)?.value;
  const existing = read();
  if (existing) return existing;
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(SECRET_KEY, randomBytes(24).toString('hex'));
  return read()!;
}

// ── syncState bookkeeping ───────────────────────────────────────────────────
// `syncState` is written wholesale by every backfill and every incremental with
// whatever the provider hands back — and Graph's `incremental()` returns only
// `{ deltaLinks }`. The subscription id is OURS, not the provider's, so it has
// to be carried across those writes or the very next poll orphans the
// subscription and the scheduler creates a fresh one every tick.

const PUSH_STATE_KEYS = ['subscriptionId', 'subscriptionExpires'] as const;

const parseState = (json: string | null): Record<string, unknown> => {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};   // a corrupt row must not stop a sync; the provider rewrites it anyway
  }
};

/** The push-owned keys of a stored syncState, and nothing else. */
export function pickPushState(json: string | null): Record<string, unknown> {
  const s = parseState(json);
  const out: Record<string, unknown> = {};
  for (const k of PUSH_STATE_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

/** Store the provider's new sync state, preserving the push bookkeeping already
 *  on the row. Re-reads the row so a value written while the provider call was
 *  in flight survives. */
export function writeSyncState(db: Database.Database, accountId: string, state: SyncState): void {
  const row = accounts.getAccountAny(db, accountId);
  if (!row) return;
  accounts.updateAccount(db, accountId, { syncState: JSON.stringify({ ...pickPushState(row.syncState), ...state }) });
}

/** The mirror image: store push bookkeeping without disturbing the provider's
 *  own state (delta links, history ids, UID watermarks). */
export function mergePushState(db: Database.Database, accountId: string, patch: Record<string, unknown>): void {
  const row = accounts.getAccountAny(db, accountId);
  if (!row) return;
  accounts.updateAccount(db, accountId, { syncState: JSON.stringify({ ...parseState(row.syncState), ...patch }) });
}

// ── subscription lifecycle ──────────────────────────────────────────────────

/** Creates the account's Graph change-notification subscription, or renews it
 *  when it is close to expiring. Cheap and network-free when neither is due, so
 *  the scheduler can call it on every tick.
 *
 *  Never rejects: it runs inside a sync tick, and a Graph outage must not turn
 *  into a failed poll or an unhandled rejection. A failure just leaves the
 *  stored state untouched, so the next tick retries. */
export async function ensureGraphSubscription(
  ctx: MailContext, account: MailAccountRow, provider: GraphPushApi, publicUrl: string | null, now = Date.now(),
): Promise<void> {
  const base = (publicUrl ?? '').replace(/\/+$/, '');
  if (!base) return;                                   // no public URL → poll only (spec §4.2)

  const state = parseState(account.syncState);
  const id = typeof state.subscriptionId === 'string' && state.subscriptionId ? state.subscriptionId : null;
  const expires = typeof state.subscriptionExpires === 'string' ? Date.parse(state.subscriptionExpires) : NaN;
  if (id && Number.isFinite(expires) && expires - now > RENEW_WHEN_LEFT_MS) return;

  const expiration = new Date(now + SUBSCRIPTION_TTL_MS).toISOString();
  const url = base + WEBHOOK_PATH;
  try {
    const secret = getWebhookSecret(ctx.db);
    let result: { id: string; expirationDateTime: string };
    if (id) {
      try {
        result = await provider.renewSubscription(id, expiration);
      } catch (e) {
        // Graph drops a subscription it could not deliver to; renewing one it no
        // longer knows about 404s. Start a new one rather than going quiet.
        console.warn(`[mail] could not renew the Graph subscription for ${account.id}, creating a new one:`, (e as Error).message);
        result = await provider.createSubscription(url, secret, expiration);
      }
    } else {
      result = await provider.createSubscription(url, secret, expiration);
    }
    mergePushState(ctx.db, account.id, { subscriptionId: result.id, subscriptionExpires: result.expirationDateTime });
  } catch (e) {
    console.error(`[mail] Graph change-notification subscription failed for ${account.id}:`, (e as Error).message);
  }
}

// ── incoming notifications ──────────────────────────────────────────────────

const constantTimeEquals = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Reads a Graph notification batch and returns the accounts to re-sync.
 *
 *  Nothing in the body is trusted beyond "something changed for subscription X":
 *  a notification carries no message content we would store, and one whose
 *  `clientState` does not match the secret we handed Microsoft is dropped. */
export function handleGraphWebhook(ctx: MailContext, body: unknown, clientStateExpected: string): string[] {
  const value = (body as { value?: unknown } | null | undefined)?.value;
  if (!Array.isArray(value)) return [];

  const found = new Set<string>();
  const seen = new Map<string, string | null>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as { clientState?: unknown; subscriptionId?: unknown };
    if (typeof n.clientState !== 'string' || !constantTimeEquals(n.clientState, clientStateExpected)) continue;
    if (typeof n.subscriptionId !== 'string' || !n.subscriptionId) continue;

    let accountId = seen.get(n.subscriptionId);
    if (accountId === undefined) {
      accountId = lookupBySubscription(ctx.db, n.subscriptionId);
      seen.set(n.subscriptionId, accountId);
    }
    if (accountId) found.add(accountId);
  }
  return [...found];
}

function lookupBySubscription(db: Database.Database, subscriptionId: string): string | null {
  // Match the exact JSON fragment writeSyncState/mergePushState produce, so a
  // subscription id can never match a neighbouring key or a longer id. The id
  // comes off the wire, so LIKE's own wildcards are escaped out of it.
  const needle = JSON.stringify({ subscriptionId }).slice(1, -1);
  const pattern = '%' + needle.replace(/[\\%_]/g, c => '\\' + c) + '%';
  const row = db.prepare(`SELECT id FROM mail_accounts WHERE syncState LIKE ? ESCAPE '\\' LIMIT 1`).get(pattern) as { id: string } | undefined;
  return row?.id ?? null;
}
