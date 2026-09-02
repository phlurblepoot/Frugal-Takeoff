// src/hooks/useItemThreadLinks.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ThreadLink } from '../pages/mail/types';

const h = vi.hoisted(() => ({ links: vi.fn(), thread: vi.fn() }));
vi.mock('../utils/mailApi', () => ({ mailApi: { links: h.links, thread: h.thread } }));

import { useItemThreadLinks, __resetThreadProbeCache } from './useItemThreadLinks';

const link = (over: Partial<ThreadLink> = {}): ThreadLink => ({
  id: 'l1', threadKey: 'tk-1', subjectSnapshot: 'RFI RFI-004', firstDate: '2026-08-27T12:00:00.000Z',
  participantsJson: null, itemType: 'rfi', itemId: 'r1', projectId: 'p1', customerId: null,
  linkedByUserId: 'u1', createdAt: '2026-08-27T12:00:00.000Z',
  ...over,
});

const accounts = [{ id: 'a1' }, { id: 'a2' }];

beforeEach(() => {
  vi.clearAllMocks();
  __resetThreadProbeCache();
  h.links.mockResolvedValue([]);
  h.thread.mockRejectedValue(new Error('Request failed'));
});

describe('useItemThreadLinks', () => {
  it('asks for nothing without an item id', async () => {
    const { result } = renderHook(() => useItemThreadLinks('rfi', undefined, accounts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.links).not.toHaveBeenCalled();
    expect(result.current.links).toEqual([]);
    expect(result.current.newest).toBeNull();
  });

  it('loads the links and exposes the newest first', async () => {
    h.links.mockResolvedValue([
      link({ id: 'old', threadKey: 'tk-old', firstDate: '2026-08-01T00:00:00.000Z' }),
      link({ id: 'new', threadKey: 'tk-new', firstDate: '2026-08-27T00:00:00.000Z' }),
    ]);
    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1', accounts));
    await waitFor(() => expect(result.current.links).toHaveLength(2));
    expect(h.links).toHaveBeenCalledWith('rfi', 'r1');
    expect(result.current.newest?.id).toBe('new');
  });

  // The thread belongs to whichever of the user's mailboxes actually holds it;
  // "not found" is the server saying this user does not own that thread.
  it('resolves myThread against the account that holds the thread', async () => {
    h.links.mockResolvedValue([link()]);
    h.thread.mockImplementation(async (accountId: string) => {
      if (accountId !== 'a2') throw new Error('Request failed');
      return { thread: {}, messages: [], links: [] };
    });

    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1', accounts));
    await waitFor(() => expect(result.current.myThread).not.toBeNull());
    expect(result.current.myThread).toEqual({ accountId: 'a2', threadKey: 'tk-1', subject: 'RFI RFI-004' });
  });

  it('leaves myThread null when no account of this user holds the thread', async () => {
    h.links.mockResolvedValue([link()]);
    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1', accounts));
    // Every mailbox is asked before giving up — `resolving` alone would be a
    // race, since it is false until the links themselves have landed.
    await waitFor(() => expect(h.thread).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.myThread).toBeNull();
  });

  // A miss is a stable fact for the session: re-probing it on every mount would
  // put two 404s on the wire behind every editor open.
  it('caches probe results across mounts', async () => {
    h.links.mockResolvedValue([link()]);
    const first = renderHook(() => useItemThreadLinks('rfi', 'r1', accounts));
    await waitFor(() => expect(h.thread).toHaveBeenCalledTimes(2));
    first.unmount();

    const second = renderHook(() => useItemThreadLinks('rfi', 'r1', accounts));
    await waitFor(() => expect(second.result.current.links).toHaveLength(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(h.thread).toHaveBeenCalledTimes(2);
    expect(second.result.current.myThread).toBeNull();
  });

  it('stops probing at the first account that owns the thread', async () => {
    h.links.mockResolvedValue([link()]);
    h.thread.mockResolvedValue({ thread: {}, messages: [], links: [] });
    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1', accounts));
    await waitFor(() => expect(result.current.myThread).not.toBeNull());
    expect(h.thread).toHaveBeenCalledTimes(1);
    expect(result.current.myThread?.accountId).toBe('a1');
  });

  // reload() runs after a send, when the link the chip should show has just
  // been created — a cached "no such thread" from before the send would hide it.
  it('reload re-reads the links and re-probes', async () => {
    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1', accounts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.links).toEqual([]);

    h.links.mockResolvedValue([link()]);
    h.thread.mockResolvedValue({ thread: {}, messages: [], links: [] });
    act(() => { result.current.reload(); });

    await waitFor(() => expect(result.current.myThread?.threadKey).toBe('tk-1'));
    expect(h.links).toHaveBeenCalledTimes(2);
  });

  it('survives a links request that fails', async () => {
    h.links.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1', accounts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.links).toEqual([]);
    expect(result.current.myThread).toBeNull();
  });

  // Accounts arrive from their own request, so they are usually empty on the
  // first render — the probe has to run again once they land.
  it('probes once the account list arrives', async () => {
    h.links.mockResolvedValue([link()]);
    h.thread.mockResolvedValue({ thread: {}, messages: [], links: [] });
    const { result, rerender } = renderHook(
      ({ accts }: { accts: { id: string }[] }) => useItemThreadLinks('rfi', 'r1', accts),
      { initialProps: { accts: [] as { id: string }[] } },
    );
    await waitFor(() => expect(result.current.links).toHaveLength(1));
    expect(result.current.myThread).toBeNull();

    rerender({ accts: accounts });
    await waitFor(() => expect(result.current.myThread?.accountId).toBe('a1'));
  });
});
