// src/components/UserPresenceOverlay.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import type { SessionView } from '../context/CollaborationContext';
import { UserPresenceOverlay } from './UserPresenceOverlay';

// Fake socket for useLiveQuery's internal useCollaboration() call — same
// idiom as useLiveQuery.test.tsx.
const { fakeSocket } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((evt: string, cb: any) => { (handlers[evt] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((evt: string, cb: any) => { handlers[evt] = (handlers[evt] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
  };
  return { fakeSocket };
});

const mockCollab = vi.hoisted(() => vi.fn());
vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => mockCollab(),
}));

const getProjectsSummary = vi.hoisted(() => vi.fn());
vi.mock('../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/store')>();
  return { ...actual, getProjectsSummary };
});

const sess = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's1', userId: 'u1', name: 'nathan', role: 'admin', color: '#3b82f6',
  device: 'Windows · Chrome', location: null, editing: null, cursor: null, lastActive: 1,
  ...over,
});

const setup = (sessions: SessionView[], followedUserId: string | null = null) => {
  const setFollowedUserId = vi.fn();
  mockCollab.mockReturnValue({ sessions, mySessionId: 'me', followedUserId, setFollowedUserId, socket: fakeSocket });
  return { setFollowedUserId };
};

const renderOverlay = (path = '/dashboard') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <UserPresenceOverlay />
    </MemoryRouter>
  );

const openPopover = () => fireEvent.click(screen.getByRole('button'));

beforeEach(() => {
  getProjectsSummary.mockReset();
  getProjectsSummary.mockResolvedValue([{ id: 'p1', name: 'Dania Beach' }]);
  for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
});

describe('UserPresenceOverlay', () => {
  it('renders nothing on canvas routes', () => {
    setup([
      sess({ sessionId: 'me', userId: 'u1', name: 'nathan' }),
      sess({ sessionId: 'a1', userId: 'u2', name: 'amy' }),
    ]);
    const { container } = renderOverlay('/project/p1/page/pg9');
    expect(container.firstChild).toBeNull();
  });

  it('badge shows the group count, not the session count', () => {
    setup([
      sess({ sessionId: 'me', userId: 'u1', name: 'nathan' }),
      sess({ sessionId: 'a1', userId: 'u2', name: 'amy', device: 'Windows · Chrome' }),
      sess({ sessionId: 'a2', userId: 'u2', name: 'amy', device: 'iPad · Safari' }),
    ]);
    renderOverlay();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('expanding a multi-session group shows both device labels and resolved project locations', async () => {
    const loc = { path: '/project/p1/billing', projectId: 'p1', section: 'billing' };
    setup([
      sess({ sessionId: 'me', userId: 'u1', name: 'nathan' }),
      sess({ sessionId: 'a1', userId: 'u2', name: 'amy', device: 'Windows · Chrome', location: loc }),
      sess({ sessionId: 'a2', userId: 'u2', name: 'amy', device: 'iPad · Safari', location: loc }),
    ]);
    renderOverlay();
    openPopover();
    expect(screen.getByText('2 sessions')).toBeInTheDocument();

    fireEvent.click(screen.getByText('2 sessions'));
    expect(screen.getByText('Windows · Chrome')).toBeInTheDocument();
    expect(screen.getByText('iPad · Safari')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByText('Dania Beach · Billing')).toHaveLength(2);
    });
  });

  it("shows the user's own second session under a 'You' row without a follow checkbox", () => {
    setup([
      sess({ sessionId: 'me', userId: 'u1', name: 'nathan' }),
      sess({ sessionId: 'me2', userId: 'u1', name: 'nathan', device: 'iPad · Safari' }),
    ]);
    renderOverlay();
    openPopover();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('follow checkbox toggles setFollowedUserId with the session id', () => {
    const { setFollowedUserId } = setup([
      sess({ sessionId: 'me', userId: 'u1', name: 'nathan' }),
      sess({ sessionId: 'a1', userId: 'u2', name: 'amy' }),
    ]);
    renderOverlay();
    openPopover();

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(setFollowedUserId).toHaveBeenCalledWith('a1');
  });

  it("shows 'No other users online' when only my own single session is present", () => {
    setup([sess({ sessionId: 'me', userId: 'u1', name: 'nathan' })]);
    renderOverlay();
    openPopover();
    expect(screen.getByText('No other users online')).toBeInTheDocument();
  });
});
