// src/pages/mail/ThreadList.tsx — middle pane: search box, thread rows, and a
// footer that either pages further back through what is indexed or offers to
// backfill older mail from the provider.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Inbox, RefreshCw, Search } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { mailApi } from '../../utils/mailApi';
import { ThreadRow } from './ThreadRow';
import type { ThreadListRow } from './types';

const SEARCH_DEBOUNCE_MS = 300;
/** The refresh route answers 202 as soon as the sync worker has been nudged —
 *  the sync itself is still running. Give it a moment before re-querying so the
 *  first reload has something new in it; the live `mailThread` broadcasts the
 *  sync fires cover anything that lands after. */
const REFRESH_SETTLE_MS = 1500;

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
  /** Re-runs the list query — used after a manual refresh. */
  onReload: () => void;
  /** Hands the conversations a whole-mailbox search filed to the list, which
   *  then shows exactly those instead of the current folder. */
  onServerResults: (threadKeys: string[]) => void;
  /** How many conversations that search is showing — null when the list is in
   *  its normal folder mode. */
  serverResultCount: number | null;
  onClearServerResults: () => void;
}> = ({
  accountId, threads, loading, hasMore, onLoadMore, indexedSince, onLoadOlder,
  q, onQueryChange, selectedKey, ownAddresses, onOpen, onToggleStar, onReload,
  onServerResults, serverResultCount, onClearServerResults,
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

  // The local index only reaches back to `indexedSince` and only ever matched
  // subject/from/snippet, so a search that finds nothing here may still match
  // older mail — or body text — on the provider. The hits are filed locally,
  // but showing them means asking for them BY KEY: they are usually archived,
  // so the active folder filter would hide them, and they usually matched on
  // body text the local LIKE still cannot see.
  const [searchingServer, setSearchingServer] = useState(false);
  const runServerSearch = useCallback(async () => {
    const term = q.trim();
    if (!accountId || !term || searchingServer) return;
    setSearchingServer(true);
    try {
      const { count, threadKeys } = await mailApi.searchServer(accountId, term);
      if (threadKeys?.length) {
        toast(`Found ${count} message${count === 1 ? '' : 's'} on the server.`);
        onServerResults(threadKeys);
      } else {
        toast('No matching mail on the server.');
        onReload();
      }
    } catch {
      toast('Could not search the mailbox.', { type: 'error' });
    } finally {
      setSearchingServer(false);
    }
  }, [accountId, q, searchingServer, toast, onReload, onServerResults]);

  const searchWholeMailbox = (
    <Button variant="secondary" size="sm" onClick={runServerSearch} disabled={searchingServer || !accountId}>
      {searchingServer ? 'Searching…' : 'Search the whole mailbox'}
    </Button>
  );

  // "Check for mail now". The server only pokes the scheduler, so the spinner
  // has to outlast the request itself — hence the settle delay before the
  // reload. Live `mailThread` events keep the list honest either way.
  const [refreshing, setRefreshing] = useState(false);
  const aliveRef = useRef(true);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set on the way IN as well as cleared on the way out: StrictMode (which
  // src/main.tsx wraps the app in) mounts, unmounts and remounts in dev, so a
  // cleanup-only ref would be left false for the component's whole life and
  // the refresh spinner would never settle.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const runRefresh = useCallback(async () => {
    if (!accountId || refreshing) return;
    setRefreshing(true);
    try {
      await mailApi.refreshAccount(accountId);
      await new Promise<void>(resolve => { refreshTimer.current = setTimeout(resolve, REFRESH_SETTLE_MS); });
      if (!aliveRef.current) return;
      onReload();
    } catch {
      if (aliveRef.current) toast('Could not check for new mail.', { type: 'error' });
    } finally {
      if (aliveRef.current) setRefreshing(false);
    }
  }, [accountId, refreshing, onReload, toast]);

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
      <div className="flex items-center gap-2 border-b border-edge p-3">
        <div className="relative min-w-0 flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            placeholder="Search mail…"
            value={text}
            onChange={e => handleType(e.target.value)}
            className="w-full rounded-lg border border-edge bg-raised py-1.5 pl-8 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent-400 focus:ring-2 focus:ring-accent-500/25 focus-visible:outline-none"
          />
        </div>
        <button
          type="button"
          data-testid="mail-refresh"
          aria-label="Check for new mail"
          title="Check for new mail"
          onClick={runRefresh}
          disabled={refreshing || !accountId}
          className="shrink-0 rounded-lg border border-edge p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
        </button>
      </div>

      {serverResultCount !== null && (
        <div
          data-testid="mail-server-results-banner"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-edge bg-accent-500/10 px-3 py-2 text-xs text-ink-soft"
        >
          <span>
            Showing {serverResultCount} result{serverResultCount === 1 ? '' : 's'} from the full mailbox
          </span>
          <button
            type="button"
            onClick={onClearServerResults}
            className="font-medium text-accent-600 hover:underline dark:text-accent-400"
          >
            Clear
          </button>
        </div>
      )}

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
              action={q && serverResultCount === null ? searchWholeMailbox : undefined}
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

        {/* Reachable even when the local index DID match: Gmail sees body text
            and archived mail the local query never will, so "some results" is
            not "all results". */}
        {q && threads.length > 0 && serverResultCount === null && (
          <div className="px-3 pb-1 text-center">{searchWholeMailbox}</div>
        )}

        <div className="px-3 py-4 text-center text-xs text-ink-faint">
          {hasMore ? (
            <Button variant="ghost" size="sm" onClick={onLoadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          ) : (
            indexedSince && serverResultCount === null && (
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
