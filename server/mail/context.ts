import type Database from 'better-sqlite3';
import type { BroadcastChange } from '../realtime/changeFeed';
import type { MailCrypto } from './crypto';
import type { MailAccountRow, ImapAuth, OAuthAuth } from './accountStore';
import type { MailProvider } from './providers/types';

// TODO(Task 8): tighten types. MailScheduler lands with the sync scheduler
// (Task 8, server/mail/sync/scheduler.ts) and is a placeholder until then.
export type MailScheduler = unknown;

export interface MailContext {
  db: Database.Database;
  dataDir: string;
  crypto: MailCrypto;
  providerFactory: (account: MailAccountRow, auth: ImapAuth | OAuthAuth) => MailProvider;
  broadcastChange: BroadcastChange;
  scheduler?: MailScheduler;
}
