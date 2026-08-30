// Placeholder for Plan 2 Task 2 — real IMAP/SMTP provider (imapflow + mailparser + nodemailer).
// Exists only so createMailProvider (Task 1) compiles and can route to 'imap'.
import type { MailProvider, ProviderFolder, Envelope, SyncState, OutgoingMessage, AttachmentMeta } from './types';
import type { ImapAuth } from '../accountStore';

export interface ImapProviderOpts { fromAddress: string }

export class ImapMailProvider implements MailProvider {
  kind = 'imap' as const;
  constructor(_auth: ImapAuth, _opts: ImapProviderOpts) {
    throw new Error('ImapMailProvider not implemented yet (Plan 2 Task 2)');
  }
  listFolders(): Promise<ProviderFolder[]> { throw new Error('not implemented'); }
  backfill(_opts: { since: Date; cursor?: string }): Promise<{ messages: Envelope[]; cursor?: string; done: boolean }> { throw new Error('not implemented'); }
  incremental(_state: SyncState): Promise<{ upserts: Envelope[]; deletes: string[]; state: SyncState }> { throw new Error('not implemented'); }
  getBody(_providerMessageId: string): Promise<{ html?: string; text?: string; attachments: AttachmentMeta[] }> { throw new Error('not implemented'); }
  getAttachment(_providerMessageId: string, _attId: string): Promise<{ stream: NodeJS.ReadableStream; mime: string; size?: number; name: string }> { throw new Error('not implemented'); }
  send(_msg: OutgoingMessage): Promise<{ providerMessageId: string; providerThreadId?: string; messageIdHeader?: string }> { throw new Error('not implemented'); }
  setFlags(_ids: string[], _flags: { read?: boolean; starred?: boolean }): Promise<void> { throw new Error('not implemented'); }
  move(_ids: string[], _folderProviderId: string): Promise<void> { throw new Error('not implemented'); }
  archive(_ids: string[]): Promise<void> { throw new Error('not implemented'); }
  trash(_ids: string[]): Promise<void> { throw new Error('not implemented'); }
  saveDraft(_draft: OutgoingMessage, _existingProviderId?: string): Promise<{ providerMessageId: string }> { throw new Error('not implemented'); }
  deleteDraft(_providerMessageId: string): Promise<void> { throw new Error('not implemented'); }
  search(_query: string, _opts: { before?: Date; limit: number }): Promise<Envelope[]> { throw new Error('not implemented'); }
}
