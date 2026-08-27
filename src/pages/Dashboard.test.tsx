// src/pages/Dashboard.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor as rtlWaitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { hoursThisWeek, startOfWeek, timeAgo } from './Dashboard';

const { fakeSocket, getProjectsSummary, getActivity, getMyTimeEntries, getTasks } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return {
    fakeSocket,
    getProjectsSummary: vi.fn(),
    getActivity: vi.fn(),
    getMyTimeEntries: vi.fn(),
    getTasks: vi.fn(),
  };
});
vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));
vi.mock('../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()), getProjectsSummary, getActivity, getMyTimeEntries, getTasks,
}));

// Imported after the mocks above so Dashboard picks up the mocked store/collaboration context.
import { Dashboard } from './Dashboard';

function mount() {
  return render(<MemoryRouter><Dashboard /></MemoryRouter>);
}

describe('startOfWeek', () => {
  it('returns the preceding Monday at 00:00', () => {
    // Wed 2026-06-10 15:30 local → Mon 2026-06-08 00:00 local
    const wed = new Date(2026, 5, 10, 15, 30);
    const start = new Date(startOfWeek(wed));
    expect(start.getDay()).toBe(1); // Monday
    expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
    expect(start.getDate()).toBe(8);
  });
});

describe('hoursThisWeek', () => {
  it('sums only entries clocked in this week, counting open entries to now', () => {
    const now = new Date(2026, 5, 10, 12, 0).getTime(); // Wed noon
    const monday = startOfWeek(new Date(now));
    const entries = [
      { id: '1', projectId: null, clockIn: monday + 3_600_000, clockOut: monday + 3 * 3_600_000, description: '' }, // 2h
      { id: '2', projectId: null, clockIn: now - 1_800_000, clockOut: null, description: '' },                      // 0.5h open
      { id: '3', projectId: null, clockIn: monday - 24 * 3_600_000, clockOut: monday - 20 * 3_600_000, description: '' }, // last week
    ];
    expect(hoursThisWeek(entries, now)).toBeCloseTo(2.5, 5);
  });
});

describe('timeAgo', () => {
  it('formats rough relative times', () => {
    const now = Date.now();
    expect(timeAgo(now - 30_000)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86_400_000)).toBe('2d ago');
  });
});

describe('Dashboard live refresh', () => {
  beforeEach(() => {
    getProjectsSummary.mockReset();
    getActivity.mockReset();
    getMyTimeEntries.mockReset();
    getTasks.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });

  it('refetches when a foreign task event arrives', async () => {
    getProjectsSummary.mockResolvedValue([]);
    getActivity.mockResolvedValue([]);
    getMyTimeEntries.mockResolvedValue([]);
    getTasks.mockResolvedValue([]);
    mount();
    await rtlWaitFor(() => expect(getActivity).toHaveBeenCalledTimes(1));
    expect(getTasks).toHaveBeenCalledTimes(1);

    act(() => {
      fakeSocket.fire('entity-changed', { type: 'task', id: 't1', action: 'created', bySessionId: 'other-tab' });
    });

    await rtlWaitFor(() => expect(getActivity).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await rtlWaitFor(() => expect(getTasks).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });
});
