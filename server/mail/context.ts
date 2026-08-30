import type Database from 'better-sqlite3';
import type { BroadcastChange } from '../realtime/changeFeed';
import type { MailCrypto } from './crypto';
import type { MailAccountRow, ImapAuth, OAuthAuth } from './accountStore';
import type { MailProvider } from './providers/types';
import type { MailScheduler } from './sync/scheduler';

export interface MailContext {
  db: Database.Database;
  dataDir: string;
  crypto: MailCrypto;
  providerFactory: (account: MailAccountRow, auth: ImapAuth | OAuthAuth) => MailProvider;
  broadcastChange: BroadcastChange;
  scheduler?: MailScheduler;
}
