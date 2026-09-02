// src/pages/mail/ThreadList.tsx — middle pane: search box, thread rows, and a
// footer that either pages further back through what is indexed or offers to
// backfill older mail from the provider.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Inbox, Search } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { ThreadRow } from './ThreadRow';
import type { ThreadListRow } from './types';

const SEARCH_DEBOUNCE_MS = 300;

const sinceLabel = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const ThreadList: React.FC<{
  threads: ThreadListRow[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  indexedSince: string | null;
  onLoadOlder: () => void;
  q: string;
  onQueryChange: (q: string) => void;
  selectedKey: string | null;
  ownAddresses: string[];
  onOpen: (row: ThreadListRow) => void;
  onToggleStar: (row: ThreadListRow) => void;
}> = ({
  threads, loading, hasMore, onLoadMore, indexedSince, onLoadOlder,
  q, onQueryChange, selectedKey, ownAddresses, onOpen, onToggleStar,
}) => {
  // The input is local so typing stays responsive; the URL only learns about
  // it after the debounce. `lastQ` keeps an external change (navigation, a
  // cleared search) from stomping on characters typed since.
  const [text, setText] = useState(q);
  const lastQ = useRef(q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (q === lastQ.current) return;
    lastQ.current = q;
    setText(q);
  }, [q]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const handleType = useCallback((value: string) => {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastQ.current = value;
      onQueryChange(value);
    }, SEARCH_DEBOUNCE_MS);
  }, [onQueryChange]);

  // Auto-page when the sentinel scrolls into view; the button below it stays
  // as the keyboard/no-IntersectionObserver path.
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  useEffect(() => {
    const el = sentinel.current;
    if (!hasMore || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) loadMoreRef.current(); },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, threads.length]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="border-b border-edge p-3">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            placeholder="Search mail…"
            value={text}
            onChange={e => handleType(e.target.value)}
            className="w-full rounded-lg border border-edge bg-raised py-1.5 pl-8 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent-400 focus:ring-2 focus:ring-accent-500/25 focus-visible:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && threads.length === 0 ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        ) : threads.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Inbox size={20} />}
              title={q ? 'No matching mail' : 'Nothing here'}
              description={q ? 'Try a different search term.' : 'This folder has no conversations yet.'}
            />
          </div>
        ) : (
          threads.map(row => (
            <ThreadRow
              key={row.threadKey}
              row={row}
              selected={row.threadKey === selectedKey}
              ownAddresses={ownAddresses}
              onOpen={() => onOpen(row)}
              onToggleStar={() => onToggleStar(row)}
            />
          ))
        )}

        <div ref={sentinel} />

        <div className="px-3 py-4 text-center text-xs text-ink-faint">
          {hasMore ? (
            <Button variant="ghost" size="sm" onClick={onLoadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          ) : (
            indexedSince && (
              <>
                <span>Showing mail since {sinceLabel(indexedSince)}</span>
                <span aria-hidden="true"> · </span>
                <button
                  type="button"
                  onClick={onLoadOlder}
                  className="font-medium text-accent-600 hover:underline dark:text-accent-400"
                >
                  Load older mail
                </button>
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
};
