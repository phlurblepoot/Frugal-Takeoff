// src/pages/mail/ThreadList.tsx — middle pane: search box, thread rows, and a
// footer that either pages further back through what is indexed or offers to
// backfill older mail from the provider.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Inbox, Search } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { mailApi } from '../../utils/mailApi';
import { ThreadRow } from './ThreadRow';
import type { ThreadListRow } from './types';

const SEARCH_DEBOUNCE_MS = 300;

const sinceLabel = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const ThreadList: React.FC<{
  accountId: string | null;
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
  /** Re-runs the list query — used after a server-side search files new hits. */
  onReload: () => void;
}> = ({
  accountId, threads, loading, hasMore, onLoadMore, indexedSince, onLoadOlder,
  q, onQueryChange, selectedKey, ownAddresses, onOpen, onToggleStar, onReload,
}) => {
  const { toast } = useToast();
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

  // The local index only goes back as far as `indexedSince`, so a search that
  // finds nothing here may still match older mail on the provider. That search
  // files whatever it finds into the index, which is why the same local query
  // finds it on the reload right after.
  const [searchingServer, setSearchingServer] = useState(false);
  const runServerSearch = useCallback(async () => {
    const term = q.trim();
    if (!accountId || !term || searchingServer) return;
    setSearchingServer(true);
    try {
      const { count } = await mailApi.searchServer(accountId, term);
      toast(count > 0 ? `Found ${count} message${count === 1 ? '' : 's'} on the server.` : 'No matching mail on the server.');
      onReload();
    } catch {
      toast('Could not search the mailbox.', { type: 'error' });
    } finally {
      setSearchingServer(false);
    }
  }, [accountId, q, searchingServer, toast, onReload]);

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
              description={
                q
                  ? 'Nothing matches in the mail indexed on this device.'
                  : 'This folder has no conversations yet.'
              }
              action={
                q ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={runServerSearch}
                    disabled={searchingServer || !accountId}
                  >
                    {searchingServer ? 'Searching…' : 'Search the whole mailbox'}
                  </Button>
                ) : undefined
              }
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
