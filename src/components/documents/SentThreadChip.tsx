// src/components/documents/SentThreadChip.tsx
// "This was emailed — here's the conversation." Sits next to the freshness chip
// in DocumentActionsBar so the answer to "did anyone send this, and what did
// they say?" is on the record itself rather than in someone's Sent folder.
//
// Presentational on purpose: DocumentActionsBar already runs
// useItemThreadLinks (it needs the same thread for the composer's "Reply in
// existing thread" option), so the chip takes the resolved values instead of
// loading them a second time.
import React from 'react';
import { Link } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { formatMailDate } from '../../pages/mail/mailFormat';
import type { ItemThread } from '../../hooks/useItemThreadLinks';
import type { ThreadLink } from '../../pages/mail/types';

// MailPage reads `_` as "no folder filter" (useThreadList.NO_FOLDER). A link
// row records the thread, not which folder it was filed in, so the deep link
// says "any folder" and lets the page settle the rest.
const ANY_FOLDER = '_';

export const SentThreadChip: React.FC<{
  /** The newest thread link for this item, or null when it has never been sent. */
  link: ThreadLink | null;
  /** Set when one of the current user's mailboxes actually holds that thread. */
  myThread: ItemThread | null;
  /** True while we are still asking which mailbox holds it. */
  resolving?: boolean;
  'data-testid'?: string;
}> = ({ link, myThread, resolving = false, 'data-testid': testId = 'sent-thread-chip' }) => {
  if (!link) return null;

  const date = formatMailDate(link.firstDate ?? link.createdAt);
  const base = 'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap';

  // Someone else's mailbox holds it: say so plainly instead of offering a link
  // that would 404, and don't pretend the item was never sent. While the lookup
  // is still running the chip states the fact it already knows — that this went
  // out — and makes no claim about whose mailbox holds it.
  if (!myThread) {
    return (
      <span
        className={`${base} border-edge bg-sunken text-ink-faint`}
        data-testid={testId}
        title={resolving
          ? 'Looking for the conversation…'
          : "Sent from another user's mailbox — only they can open the conversation"}
      >
        <MailCheck size={12} />
        Sent{date ? ` · ${date}` : ''}{resolving ? '' : ' · by another user'}
      </span>
    );
  }

  return (
    <Link
      to={`/mail/${encodeURIComponent(myThread.accountId)}/${ANY_FOLDER}/${encodeURIComponent(myThread.threadKey)}`}
      className={`${base} border-edge bg-raised text-ink hover:bg-hover`}
      data-testid={testId}
      title={link.subjectSnapshot ?? 'Open the email thread'}
    >
      <MailCheck size={12} />
      Sent{date ? ` · ${date}` : ''} · Open thread
    </Link>
  );
};
