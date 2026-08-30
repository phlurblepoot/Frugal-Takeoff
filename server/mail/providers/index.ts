// server/mail/providers/index.ts
// The one place a MailAccountRow turns into a live MailProvider. Plan 2 fills in
// the real IMAP/Google/Microsoft implementations; until then only the in-memory
// fake is wired, so a migrated SMTP account (status 'needs_review') can be
// listed and edited but not synced or sent through.
import type { MailAccountRow, ImapAuth, OAuthAuth } from '../accountStore';
import type { MailProvider } from './types';
import { getFakeProvider } from './fakeRegistry';

export function createMailProvider(account: MailAccountRow, _auth: ImapAuth | OAuthAuth): MailProvider {
  // MAIL_FAKE_PROVIDER=1 routes every account through the fake — the dev/e2e
  // switch that lets the whole mail UI be exercised without real credentials.
  if (process.env.MAIL_FAKE_PROVIDER === '1' || account.provider === 'fake') return getFakeProvider(account.id);
  throw new Error(`Mail provider "${account.provider}" is not installed yet`);
}
