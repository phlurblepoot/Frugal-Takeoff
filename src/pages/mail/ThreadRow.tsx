// src/pages/mail/ThreadRow.tsx — one conversation in the thread list:
// unread dot · participants + message count · subject · snippet · link chips,
// with the date, paperclip and star on the right.
import React from 'react';
import { Paperclip, Star } from 'lucide-react';
import type { ThreadListRow } from './types';
import { formatMailDate, itemTypeLabel, participantsLabel } from './mailFormat';

export const ThreadRow: React.FC<{
  row: ThreadListRow;
  selected: boolean;
  ownAddresses: string[];
  onOpen: () => void;
  onToggleStar: () => void;
}> = ({ row, selected, ownAddresses, onOpen, onToggleStar }) => {
  const unread = row.unreadCount > 0;
  const starred = row.isStarred > 0;

  // A thread linked to three RFIs still gets one "RFI" chip — the chips say
  // what kind of work the thread touches, not how many rows it touches.
  const chipTypes = Array.from(new Set(row.links.map(l => l.itemType)));

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="mail-thread-row"
      data-thread-key={row.threadKey}
      data-unread={String(unread)}
      data-selected={String(selected)}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`flex w-full cursor-pointer gap-2 border-b border-edge px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
        selected ? 'bg-hover' : unread ? 'bg-raised' : ''
      }`}
    >
      <span className="mt-1.5 flex w-2 shrink-0 justify-center" aria-hidden="true">
        {unread && <span className="size-2 rounded-full bg-accent-500" />}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-sm ${unread ? 'font-semibold text-ink' : 'text-ink-soft'}`}>
            {participantsLabel(row.participants, ownAddresses)}
          </span>
          {row.messageCount > 1 && (
            <span className="shrink-0 rounded bg-sunken px-1 text-[11px] leading-4 text-ink-faint">{row.messageCount}</span>
          )}
          <span className="shrink-0 text-xs text-ink-faint">{formatMailDate(row.lastDate)}</span>
        </div>

        <div className="flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-sm ${unread ? 'font-semibold text-ink' : 'text-ink'}`}>
            {row.subject || '(no subject)'}
          </span>
          {row.hasAttachments > 0 && (
            <Paperclip data-testid="mail-attachment-icon" size={13} className="shrink-0 text-ink-faint" />
          )}
          <button
            type="button"
            aria-label={starred ? 'Unstar' : 'Star'}
            onClick={e => {
              e.stopPropagation();
              onToggleStar();
            }}
            className="-my-1 shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <Star size={14} className={starred ? 'fill-amber-400 text-amber-500' : ''} />
          </button>
        </div>

        {row.snippet && <p className="truncate text-xs text-ink-faint">{row.snippet}</p>}

        {chipTypes.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {chipTypes.map(t => (
              <span
                key={t}
                data-testid="mail-link-chip"
                className="rounded bg-accent-500/10 px-1.5 py-0.5 text-[11px] font-medium text-accent-700 dark:text-accent-300"
              >
                {itemTypeLabel(t)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
