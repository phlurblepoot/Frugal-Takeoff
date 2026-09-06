// src/components/shell/SidebarPresence.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SessionView } from '../../context/CollaborationContext';

const mkSession = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's1', userId: 'u1', name: 'Sarah', role: 'user', color: '#40c9c6',
  device: 'Linux · Chrome', location: { path: '/dashboard' }, editing: null,
  cursor: null, lastActive: Date.now(), ...over,
});

const collab = {
  sessions: [] as SessionView[],
  mySessionId: 'me',
  followedSessionId: null as string | null,
  setFollowedSessionId: vi.fn(),
  updateUser: vi.fn(),
};
vi.mock('../../context/CollaborationContext', async (orig) => ({
  ...(await orig()),
  useCollaboration: () => collab,
}));
vi.mock('../../hooks/useLiveQuery', () => ({ useLiveQuery: () => {} }));
vi.mock('../../utils/store', async (orig) => ({
  ...(await orig()),
  getProjectsSummary: vi.fn(async () => []),
}));

const { SidebarPresence } = await import('./SidebarPresence');

const renderIt = () => render(
  <MemoryRouter><SidebarPresence expanded /></MemoryRouter>
);

describe('SidebarPresence', () => {
  beforeEach(() => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Nathan' }),
      mkSession({ sessionId: 's2', userId: 'u2', name: 'Sarah' }),
    ];
    collab.setFollowedSessionId.mockClear();
  });

  it('shows the online count', () => {
    renderIt();
    expect(screen.getByTestId('sidebar-presence')).toHaveTextContent('2 online');
  });

  it('opens a popover listing users with Follow controls', () => {
    renderIt();
    fireEvent.click(screen.getByTestId('sidebar-presence'));
    expect(screen.getByTestId('presence-popover')).toBeInTheDocument();
    expect(screen.getByText('Sarah')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /follow sarah/i }));
    expect(collab.setFollowedSessionId).toHaveBeenCalledWith('s2');
  });

  it('renders nothing when you are the only session', () => {
    collab.sessions = [mkSession({ sessionId: 'me', name: 'Nathan' })];
    renderIt();
    // Still shows the stack (1 online) — presence is a permanent fixture:
    expect(screen.getByTestId('sidebar-presence')).toHaveTextContent('1 online');
  });

  it('merges a second tab of my own account into the self group instead of dropping it', () => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Nathan', device: 'Windows · Chrome' }),
      mkSession({ sessionId: 'me2', userId: 'me-u', name: 'Nathan', device: 'iPad · Safari' }),
    ];
    renderIt();
    // One user online (both sessions are mine), not two:
    expect(screen.getByTestId('sidebar-presence')).toHaveTextContent('1 online');

    fireEvent.click(screen.getByTestId('sidebar-presence'));
    // Both sessions' device lines render under the single "(you)" row —
    // the second tab must not be dropped.
    expect(screen.getByText(/Windows · Chrome/)).toBeInTheDocument();
    expect(screen.getByText(/iPad · Safari/)).toBeInTheDocument();
    expect(screen.getAllByText(/\(you\)/)).toHaveLength(1);
    // A same-account session never gets a Follow checkbox:
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
