// src/pages/Dashboard.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen, within, waitFor as rtlWaitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { hoursThisWeek, startOfWeek, timeAgo } from './Dashboard';
import type { OutstandingProposal } from '../utils/store';

const { fakeSocket, getProjectsSummary, getActivity, getMyTimeEntries, getTasks, getOutstandingProposals } = vi.hoisted(() => {
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
    getOutstandingProposals: vi.fn(),
  };
});
vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));
vi.mock('../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()), getProjectsSummary, getActivity, getMyTimeEntries, getTasks, getOutstandingProposals,
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

const outstandingProposal = (over: Partial<OutstandingProposal> = {}): OutstandingProposal => ({
  id: 'pr1', projectId: 'proj1', projectName: 'Stucco Job', number: 3, revisedFromId: null, revisedFromNumber: null,
  status: 'sent', legacy: false, title: null, validUntil: null,
  fontFamily: null, coverNotes: null, terms: null, inclusions: [], exclusions: [], paymentSchedule: null,
  showGrandTotal: true, includeCostDetail: false, includeSignature: true, highlightQuality: 'best',
  fileId: null, signedFileId: null, sentAt: Date.now(), sentTo: null, acceptedAt: null, declinedAt: null,
  version: 1, createdBy: null, createdAt: 0, updatedAt: 0,
  totalCents: 250000, alternateCount: 0, hasOverride: false, photoCount: 0, attachmentCount: 0,
  ...over,
});

describe('Dashboard outstanding proposals card', () => {
  beforeEach(() => {
    getProjectsSummary.mockReset().mockResolvedValue([]);
    getActivity.mockReset().mockResolvedValue([]);
    getMyTimeEntries.mockReset().mockResolvedValue([]);
    getTasks.mockReset().mockResolvedValue([]);
    getOutstandingProposals.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });
  afterEach(() => localStorage.removeItem('user'));

  it('is not shown to a non-admin, and never fetches outstanding proposals', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'user' }));
    mount();
    await rtlWaitFor(() => expect(getActivity).toHaveBeenCalledTimes(1));
    expect(getOutstandingProposals).not.toHaveBeenCalled();
    expect(screen.queryByText('Outstanding proposals')).not.toBeInTheDocument();
  });

  it('lists an admin\'s outstanding proposals with amount and expiry, capped at 6, linking to the editor', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'admin' }));
    const rows = [
      outstandingProposal({ id: 'pr1', title: 'Stucco package', totalCents: 250000, validUntil: '2000-01-01' }), // expired
      ...Array.from({ length: 6 }, (_, i) => outstandingProposal({ id: `extra-${i}`, number: 10 + i })),
    ];
    getOutstandingProposals.mockResolvedValue(rows);
    mount();

    await rtlWaitFor(() => expect(getOutstandingProposals).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Outstanding proposals')).toBeInTheDocument();
    const firstRow = screen.getByText(/Stucco Job · #3 — Stucco package/).closest('a')!;
    expect(within(firstRow).getByText('$2,500.00')).toBeInTheDocument();
    const expired = within(firstRow).getByText(/expired/);
    expect(expired.className).toMatch(/text-red-600/);
    expect(firstRow).toHaveAttribute('href', '/project/proj1/proposal/pr1');

    // 7 rows fetched, only 6 rendered.
    const links = screen.getAllByRole('link', { name: /Stucco Job/ });
    expect(links).toHaveLength(6);
  });

  it('shows an empty state when there is nothing outstanding', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'admin' }));
    getOutstandingProposals.mockResolvedValue([]);
    mount();
    expect(await screen.findByText('No proposals awaiting a response.')).toBeInTheDocument();
  });

  it('refetches outstanding proposals when a proposal event arrives', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', role: 'admin' }));
    getOutstandingProposals.mockResolvedValue([]);
    mount();
    await rtlWaitFor(() => expect(getOutstandingProposals).toHaveBeenCalledTimes(1));

    act(() => {
      fakeSocket.fire('entity-changed', { type: 'proposal', id: 'pr9', action: 'created', bySessionId: 'other-tab' });
    });

    await rtlWaitFor(() => expect(getOutstandingProposals).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });
});
