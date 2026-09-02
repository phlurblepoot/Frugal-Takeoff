// src/pages/mail/compose/useDraftAutosave.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Addr } from '../types';

const h = vi.hoisted(() => ({ saveDraft: vi.fn(), deleteDraft: vi.fn() }));
vi.mock('../../../utils/mailApi', () => ({ mailApi: { saveDraft: h.saveDraft, deleteDraft: h.deleteDraft } }));

import { DRAFT_DEBOUNCE_MS, useDraftAutosave, type DraftSnapshot } from './useDraftAutosave';

const snap = (over: Partial<DraftSnapshot> = {}): DraftSnapshot => ({
  to: [] as Addr[], cc: [], bcc: [], subject: '', html: '', ...over,
});

const setup = (initial: DraftSnapshot = snap(), opts: { accountId?: string | null; enabled?: boolean } = {}) =>
  renderHook(
    ({ s }: { s: DraftSnapshot }) =>
      useDraftAutosave({
        accountId: opts.accountId === undefined ? 'a1' : opts.accountId,
        enabled: opts.enabled ?? true,
        get: () => s,
      }),
    { initialProps: { s: initial } }
  );

const tick = async (ms = DRAFT_DEBOUNCE_MS) => {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.saveDraft.mockResolvedValue({ draftId: 'd1' });
  h.deleteDraft.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('useDraftAutosave', () => {
  it('does not save the snapshot it was mounted with', async () => {
    setup(snap({ subject: 'Seeded' }));
    await tick();
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  it('creates a draft 3s after the first change, then updates it in place', async () => {
    const { result, rerender } = setup();

    rerender({ s: snap({ subject: 'Hello' }) });
    await act(async () => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1); });
    expect(h.saveDraft).not.toHaveBeenCalled();

    await tick(1);
    expect(h.saveDraft).toHaveBeenCalledTimes(1);
    expect(h.saveDraft).toHaveBeenCalledWith(
      { accountId: 'a1', to: [], cc: [], bcc: [], subject: 'Hello', html: '' },
      undefined
    );
    expect(result.current.draftId).toBe('d1');
    expect(result.current.status).toBe('saved');
    expect(result.current.savedAt).toBeInstanceOf(Date);

    rerender({ s: snap({ subject: 'Hello again' }) });
    await tick();
    expect(h.saveDraft).toHaveBeenCalledTimes(2);
    expect(h.saveDraft.mock.calls[1][1]).toBe('d1');
  });

  it('collapses rapid edits into one save', async () => {
    const { rerender } = setup();
    rerender({ s: snap({ subject: 'a' }) });
    await act(async () => { vi.advanceTimersByTime(1000); });
    rerender({ s: snap({ subject: 'ab' }) });
    await act(async () => { vi.advanceTimersByTime(1000); });
    rerender({ s: snap({ subject: 'abc' }) });
    await tick();
    expect(h.saveDraft).toHaveBeenCalledTimes(1);
    expect(h.saveDraft.mock.calls[0][0].subject).toBe('abc');
  });

  it('reports an error status when the save fails', async () => {
    h.saveDraft.mockRejectedValue(new Error('nope'));
    const { result, rerender } = setup();
    rerender({ s: snap({ subject: 'Hello' }) });
    await tick();
    expect(result.current.status).toBe('error');
    expect(result.current.draftId).toBeNull();
  });

  it('stays idle when disabled or without an account', async () => {
    const off = setup(snap(), { enabled: false });
    off.rerender({ s: snap({ subject: 'x' }) });
    await tick();
    expect(h.saveDraft).not.toHaveBeenCalled();

    const anon = setup(snap(), { accountId: null });
    anon.rerender({ s: snap({ subject: 'x' }) });
    await tick();
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  it('does not fire a pending save after unmount', async () => {
    const { rerender, unmount } = setup();
    rerender({ s: snap({ subject: 'Hello' }) });
    unmount();
    await tick();
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  it('discard deletes the saved draft and resets', async () => {
    const { result, rerender } = setup();
    rerender({ s: snap({ subject: 'Hello' }) });
    await tick();
    expect(result.current.draftId).toBe('d1');

    await act(async () => { await result.current.discard(); });
    expect(h.deleteDraft).toHaveBeenCalledWith('a1', 'd1');
    expect(result.current.draftId).toBeNull();
    expect(result.current.status).toBe('idle');
  });

  it('starts a fresh draft when the composer is reopened', async () => {
    const { result, rerender } = renderHook(
      ({ s, enabled }: { s: DraftSnapshot; enabled: boolean }) =>
        useDraftAutosave({ accountId: 'a1', enabled, get: () => s }),
      { initialProps: { s: snap(), enabled: true } }
    );

    rerender({ s: snap({ subject: 'First' }), enabled: true });
    await tick();
    expect(result.current.draftId).toBe('d1');

    rerender({ s: snap(), enabled: false });          // composer closed
    rerender({ s: snap(), enabled: true });           // reopened
    expect(result.current.draftId).toBeNull();

    h.saveDraft.mockResolvedValue({ draftId: 'd2' });
    rerender({ s: snap({ subject: 'Second' }), enabled: true });
    await tick();
    expect(h.saveDraft.mock.calls.at(-1)![1]).toBeUndefined();
  });

  it('discard is a no-op with nothing saved', async () => {
    const { result } = setup();
    await act(async () => { await result.current.discard(); });
    expect(h.deleteDraft).not.toHaveBeenCalled();
  });
});
