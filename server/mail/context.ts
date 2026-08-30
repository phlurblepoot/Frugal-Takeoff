import type Database from 'better-sqlite3';
import type { BroadcastChange } from '../realtime/changeFeed';
import type { MailCrypto } from './crypto';
import type { MailAccountRow, ImapAuth, OAuthAuth } from './accountStore';

// TODO(Task 5/8): tighten types. MailProvider lands with the provider
// implementations (Task 5, server/mail/providers/types.ts); MailScheduler
// lands with the sync scheduler (Task 8, server/mail/sync/scheduler.ts).
// Both are placeholders until those modules exist.
export type MailProvider = unknown;
export type MailScheduler = unknown;

export interface MailContext {
  db: Database.Database;
  dataDir: string;
  crypto: MailCrypto;
  providerFactory: (account: MailAccountRow, auth: ImapAuth | OAuthAuth) => MailProvider;
  broadcastChange: BroadcastChange;
  scheduler?: MailScheduler;
}
