// server/onlyoffice/links.ts — the short-lived links ONLYOFFICE (or, for
// change logs, the browser inside ONLYOFFICE's frame) uses to fetch one thing
// from this app. See tokens.ts for why these never reuse a login token.
import type { OnlyofficeConfig } from './config';
import type { LinkTokens } from './tokens';

// ONLYOFFICE downloads when the first person opens the file; the margin covers
// an editor tab left open all day that has to reconnect. A link opens one
// file, read-only, for someone who could already read it.
export const FILE_LINK_TTL_SECONDS = 8 * 3600;

export const fileSubject = (fileId: string) => `file:${fileId}`;
/** One mail attachment, for the viewer (Phase 6). Short: the Document Server
 *  fetches it once, as the viewer opens. */
export const MAIL_ATTACHMENT_LINK_TTL_SECONDS = 3600;
export const mailAttachmentSubject = (messageId: string, attId: string) => `mailatt:${messageId}:${attId}`;
export const changesSubject = (fileId: string, version: number) => `changes:${fileId}:${version}`;

/** ONLYOFFICE's download link for one stored file (a live file or an archived
 *  version row), over the Docker network. */
export const fileLink = (cfg: OnlyofficeConfig, tokens: LinkTokens, fileId: string): string =>
  `${cfg.appInternalUrl}/api/onlyoffice/file/${encodeURIComponent(fileId)}?t=${encodeURIComponent(tokens.sign(fileSubject(fileId), FILE_LINK_TTL_SECONDS))}`;
