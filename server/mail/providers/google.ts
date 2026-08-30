// Placeholder for Plan 2 Task 3 — real Gmail API provider (googleapis).
// Exists only so createMailProvider (Task 1) compiles and can route to 'google'.
import type { MailProvider, ProviderFolder, Envelope, SyncState, OutgoingMessage, AttachmentMeta, MoveResult } from './types';
import type { TokenSource } from './tokenSource';

export interface GoogleProviderOpts { fetch: typeof fetch; emailAddress: string }

export async function googleRefresh(
  _env: NodeJS.ProcessEnv,
  _refreshToken: string,
  _fetchFn: typeof fetch,
): Promise<{ accessToken: string; expiresInSec: number; refreshToken?: string }> {
  throw new Error('googleRefresh not implemented yet (Plan 2 Task 3)');
}

export class GmailProvider implements MailProvider {
  kind = 'google' as const;
  constructor(_tokenSource: TokenSource, _opts: GoogleProviderOpts) {
    throw new Error('GmailProvider not implemented yet (Plan 2 Task 3)');
  }
  listFolders(): Promise<ProviderFolder[]> { throw new Error('not implemented'); }
  backfill(_opts: { since: Date; cursor?: string }): Promise<{ messages: Envelope[]; cursor?: string; done: boolean }> { throw new Error('not implemented'); }
  incremental(_state: SyncState): Promise<{ upserts: Envelope[]; deletes: string[]; state: SyncState }> { throw new Error('not implemented'); }
  getBody(_providerMessageId: string): Promise<{ html?: string; text?: string; attachments: AttachmentMeta[] }> { throw new Error('not implemented'); }
  getAttachment(_providerMessageId: string, _attId: string): Promise<{ stream: NodeJS.ReadableStream; mime: string; size?: number; name: string }> { throw new Error('not implemented'); }
  send(_msg: OutgoingMessage): Promise<{ providerMessageId: string; providerThreadId?: string; messageIdHeader?: string }> { throw new Error('not implemented'); }
  setFlags(_ids: string[], _flags: { read?: boolean; starred?: boolean }): Promise<void> { throw new Error('not implemented'); }
  move(_ids: string[], _folderProviderId: string): Promise<MoveResult[]> { throw new Error('not implemented'); }
  archive(_ids: string[]): Promise<MoveResult[]> { throw new Error('not implemented'); }
  trash(_ids: string[]): Promise<MoveResult[]> { throw new Error('not implemented'); }
  saveDraft(_draft: OutgoingMessage, _existingProviderId?: string): Promise<{ providerMessageId: string }> { throw new Error('not implemented'); }
  deleteDraft(_providerMessageId: string): Promise<void> { throw new Error('not implemented'); }
  search(_query: string, _opts: { before?: Date; limit: number }): Promise<Envelope[]> { throw new Error('not implemented'); }
}
