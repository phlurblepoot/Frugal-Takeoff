// src/pages/mail/ThreadList.test.tsx — the middle pane on its own: the
// debounced search box, the rows, the paging footer, and the two empty states
// (including the "search the whole mailbox" fallback for mail older than the
// local index).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ThreadListRow } from './types';

const h = vi.hoisted(() => ({ searchServer: vi.fn(), refreshAccount: vi.fn(), toast: vi.fn() }));
vi.mock('../../utils/mailApi', () => ({ mailApi: { searchServer: h.searchServer, refreshAccount: h.refreshAccount } }));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));

import { ThreadList } from './ThreadList';

const row = (over: Partial<ThreadListRow> = {}): ThreadListRow => ({
  threadKey: 'tk-1', subject: 'Roof detail', firstDate: '2026-08-27T12:00:00.000Z',
  lastDate: '2026-08-27T12:00:00.000Z', messageCount: 2, unreadCount: 1, hasAttachments: 0, isStarred: 0,
  participants: [{ addr: 'bob@acme.com', name: 'Bob Smith' }], folderIds: ['f-inbox'],
  snippet: 'Please review the attached detail', links: [], ...over,
});

type Props = React.ComponentProps<typeof ThreadList>;

const props = (over: Partial<Props> = {}): Props => ({
  accountId: 'a1',
  threads: [row()],
  loading: false,
  hasMore: false,
  onLoadMore: vi.fn(),
  indexedSince: null,
  onLoadOlder: vi.fn(),
  q: '',
  onQueryChange: vi.fn(),
  selectedKey: null,
  ownAddresses: ['nathan@bigbearplaster.com'],
  onOpen: vi.fn(),
  onToggleStar: vi.fn(),
  onReload: vi.fn(),
  onServerResults: vi.fn(),
  serverResultCount: null,
  onClearServerResults: vi.fn(),
  ...over,
});

const searchBox = () => screen.getByPlaceholderText('Search mail…');

beforeEach(() => {
  vi.clearAllMocks();
  h.searchServer.mockResolvedValue({ count: 0, threadKeys: [] });
  h.refreshAccount.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ThreadList', () => {
  it('renders a row per thread', () => {
    render(<ThreadList {...props({ threads: [row(), row({ threadKey: 'tk-2', subject: 'Stucco mock-up' })] })} />);
    expect(screen.getAllByTestId('mail-thread-row')).toHaveLength(2);
    expect(screen.getByText('Roof detail')).toBeInTheDocument();
    expect(screen.getByText('Stucco mock-up')).toBeInTheDocument();
  });

  // Typing stays local; the committed query (which drives a fetch and the URL)
  // only moves once the user pauses.
  it('debounces typing before it commits the query', () => {
    vi.useFakeTimers();
    const onQueryChange = vi.fn();
    render(<ThreadList {...props({ onQueryChange })} />);

    fireEvent.change(searchBox(), { target: { value: 'roo' } });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.change(searchBox(), { target: { value: 'roof' } });
    act(() => { vi.advanceTimersByTime(299); });
    expect(onQueryChange).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1); });
    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenCalledWith('roof');
  });

  it('pages further back through the index with Load more', () => {
    const onLoadMore = vi.fn();
    render(<ThreadList {...props({ hasMore: true, onLoadMore })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('offers to backfill older mail once the index has been paged to its end', () => {
    const onLoadOlder = vi.fn();
    render(<ThreadList {...props({ hasMore: false, indexedSince: '2026-02-01T00:00:00.000Z', onLoadOlder })} />);
    // (The formatted date is the machine's local rendering of the ISO stamp,
    // so the assertion stays on the label rather than a timezone-dependent day.)
    expect(screen.getByText(/Showing mail since/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Load older mail/i }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an empty folder from an empty search', () => {
    const { rerender } = render(<ThreadList {...props({ threads: [] })} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Search the whole mailbox/i })).toBeNull();

    rerender(<ThreadList {...props({ threads: [], q: 'shingle' })} />);
    expect(screen.getByText('No matching mail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Search the whole mailbox/i })).toBeInTheDocument();
  });

  // Manual "check for mail now": the route only nudges the sync worker, so the
  // list is re-queried after a settle delay rather than off the 202 itself.
  it('asks the server to sync and reloads the list once it has had a moment', async () => {
    vi.useFakeTimers();
    const onReload = vi.fn();
    render(<ThreadList {...props({ onReload })} />);

    fireEvent.click(screen.getByTestId('mail-refresh'));
    await act(async () => {});
    expect(h.refreshAccount).toHaveBeenCalledWith('a1');
    // Still spinning, and still not reloaded, until the settle delay is up.
    expect(screen.getByTestId('mail-refresh')).toBeDisabled();
    expect(onReload).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('mail-refresh')).not.toBeDisabled();
  });

  // src/main.tsx wraps the app in StrictMode, so in dev every component mounts,
  // unmounts and remounts. A cleanup-only alive ref would be left false from
  // that first teardown and the spinner would never settle again.
  it('still settles the refresh under StrictMode\'s mount/unmount/remount', async () => {
    vi.useFakeTimers();
    const onReload = vi.fn();
    render(<React.StrictMode><ThreadList {...props({ onReload })} /></React.StrictMode>);

    fireEvent.click(screen.getByTestId('mail-refresh'));
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('mail-refresh')).not.toBeDisabled();
  });

  it('reports a failed refresh instead of reloading', async () => {
    const onReload = vi.fn();
    h.refreshAccount.mockRejectedValue(new Error('nope'));
    render(<ThreadList {...props({ onReload })} />);

    fireEvent.click(screen.getByTestId('mail-refresh'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Could not check for new mail.', { type: 'error' }));
    expect(onReload).not.toHaveBeenCalled();
  });

  // The provider search files its hits and names the conversations they landed
  // in. Those hits are typically archived and typically matched on body text,
  // so re-running the LOCAL query would show nothing — the keys are what the
  // list has to be handed. (That mismatch is why "search the whole mailbox"
  // reported finds and then displayed an empty list.)
  it('hands a server search\'s thread keys to the list rather than re-running the local query', async () => {
    h.searchServer.mockResolvedValue({ count: 3, threadKeys: ['tk-9', 'tk-8'] });
    const onServerResults = vi.fn();
    const onReload = vi.fn();
    render(<ThreadList {...props({ threads: [], q: 'shingle', onServerResults, onReload })} />);

    fireEvent.click(screen.getByRole('button', { name: /Search the whole mailbox/i }));
    await waitFor(() => expect(h.searchServer).toHaveBeenCalledWith('a1', 'shingle'));
    await waitFor(() => expect(onServerResults).toHaveBeenCalledWith(['tk-9', 'tk-8']));
    expect(h.toast).toHaveBeenCalledWith('Found 3 messages on the server.');
    expect(onReload).not.toHaveBeenCalled();
  });

  it('falls back to a plain reload when the mailbox search matched nothing', async () => {
    h.searchServer.mockResolvedValue({ count: 0, threadKeys: [] });
    const onServerResults = vi.fn();
    const onReload = vi.fn();
    render(<ThreadList {...props({ threads: [], q: 'shingle', onServerResults, onReload })} />);

    fireEvent.click(screen.getByRole('button', { name: /Search the whole mailbox/i }));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(onServerResults).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('No matching mail on the server.');
  });

  it('shows the mailbox search working and does not fire it twice', async () => {
    type Hits = { count: number; threadKeys: string[] };
    let finish: (r: Hits) => void = () => {};
    h.searchServer.mockReturnValue(new Promise<Hits>(r => { finish = r; }));
    render(<ThreadList {...props({ threads: [], q: 'shingle' })} />);

    const button = screen.getByRole('button', { name: /Search the whole mailbox/i });
    fireEvent.click(button);
    const busy = await screen.findByRole('button', { name: 'Searching…' });
    expect(busy).toBeDisabled();

    fireEvent.click(busy);
    await act(async () => { finish({ count: 0, threadKeys: [] }); });
    expect(h.searchServer).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith('No matching mail on the server.');
  });

  // Local results are not all results: Gmail matches body text and archived
  // mail the local index never sees, so the escape hatch has to stay reachable
  // when the local query DID match something.
  it('offers the mailbox search alongside local results too', () => {
    render(<ThreadList {...props({ q: 'shingle' })} />);
    expect(screen.getByRole('button', { name: /Search the whole mailbox/i })).toBeInTheDocument();
  });

  describe('server-results mode', () => {
    it('banners the result count and clears back to the normal list', () => {
      const onClearServerResults = vi.fn();
      render(<ThreadList {...props({ q: 'shingle', serverResultCount: 4, onClearServerResults })} />);

      const banner = screen.getByTestId('mail-server-results-banner');
      expect(banner).toHaveTextContent('Showing 4 results from the full mailbox');
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(onClearServerResults).toHaveBeenCalledTimes(1);
    });

    it('singularises one result', () => {
      render(<ThreadList {...props({ q: 'shingle', serverResultCount: 1 })} />);
      expect(screen.getByTestId('mail-server-results-banner')).toHaveTextContent('Showing 1 result from the full mailbox');
    });

    it('drops the folder-scoped footer and the search-again button while it is showing', () => {
      render(<ThreadList {...props({ q: 'shingle', serverResultCount: 2, indexedSince: '2026-02-01T00:00:00.000Z' })} />);
      expect(screen.queryByText(/Showing mail since/)).toBeNull();
      expect(screen.queryByRole('button', { name: /Search the whole mailbox/i })).toBeNull();
    });

    it('shows no banner in the normal folder view', () => {
      render(<ThreadList {...props()} />);
      expect(screen.queryByTestId('mail-server-results-banner')).toBeNull();
    });
  });
});
