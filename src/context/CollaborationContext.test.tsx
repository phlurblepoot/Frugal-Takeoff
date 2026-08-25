import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

// Fake socket: an event-emitter with spies. hoisted so the module mock sees it.
const { fakeSocket, ioMock } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    connected: true,
    on: vi.fn((evt: string, cb: any) => { (handlers[evt] ??= []).push(cb); return fakeSocket; }),
    emit: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(),
    fire: (evt: string, ...args: any[]) => (handlers[evt] ?? []).forEach(cb => cb(...args)),
  };
  return { fakeSocket, ioMock: vi.fn((_opts?: any) => fakeSocket) };
});
vi.mock('socket.io-client', () => ({ io: ioMock }));

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigateSpy,
}));

import { CollaborationProvider, useCollaboration } from './CollaborationContext';

const SESSION = {
  sessionId: 'sA', userId: 'u1', name: 'nathan', role: 'admin', color: '#3b82f6',
  device: 'Windows · Chrome',
  location: { path: '/dashboard', label: 'Dashboard' },
  editing: null, cursor: null, lastActive: 111,
};

function Probe() {
  const { sessions, globalUsers, mySessionId } = useCollaboration();
  return (
    <div>
      <span data-testid="count">{sessions.length}</span>
      <span data-testid="self">{mySessionId ?? 'none'}</span>
      <span data-testid="legacy">{globalUsers.map(u => `${u.id}:${u.pageId}`).join(',')}</span>
    </div>
  );
}

function FollowProbe() {
  const { sessions, followedUserId, setFollowedUserId } = useCollaboration();
  return (
    <div>
      <span data-testid="followed">{followedUserId ?? 'none'}</span>
      <button data-testid="follow-sB" onClick={() => setFollowedUserId('sB')}>follow</button>
      <span data-testid="count">{sessions.length}</span>
    </div>
  );
}

const OTHER = {
  ...SESSION, sessionId: 'sB', userId: 'u2', name: 'sam',
  location: { path: '/project/p1/billing', projectId: 'p1', section: 'billing' },
};

describe('CollaborationContext', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'tok123');
    localStorage.setItem('user', JSON.stringify({ id: 'u1', username: 'nathan' }));
    ioMock.mockClear(); fakeSocket.emit.mockClear(); navigateSpy.mockClear();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });

  function mount(initialEntries: string[] = ['/dashboard']) {
    return render(
      <MemoryRouter initialEntries={initialEntries}>
        <CollaborationProvider><Probe /></CollaborationProvider>
      </MemoryRouter>
    );
  }

  it('connects with an auth payload and reports its location', () => {
    mount();
    expect(ioMock).toHaveBeenCalledTimes(1);
    const opts = ioMock.mock.calls[0][0];
    // auth is a function form so reconnects pick up fresh tokens
    const authArg = typeof opts.auth === 'function'
      ? (() => { let got: any; opts.auth((v: any) => { got = v; }); return got; })()
      : opts.auth;
    expect(authArg.token).toBe('tok123');
    expect(fakeSocket.emit).toHaveBeenCalledWith('set-location',
      expect.objectContaining({ path: '/dashboard' }));
  });

  it('builds sessions from snapshot and applies joined/left/updated deltas', () => {
    mount();
    act(() => fakeSocket.fire('sessions-snapshot', { selfId: 'sA', sessions: [SESSION] }));
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getByTestId('self').textContent).toBe('sA');
    act(() => fakeSocket.fire('session-joined', { ...SESSION, sessionId: 'sB', userId: 'u2', name: 'sam' }));
    expect(screen.getByTestId('count').textContent).toBe('2');
    act(() => fakeSocket.fire('session-updated', { ...SESSION, sessionId: 'sB', userId: 'u2', name: 'sam', color: '#000000' }));
    expect(screen.getByTestId('count').textContent).toBe('2');
    act(() => fakeSocket.fire('session-left', { sessionId: 'sB' }));
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('derives the legacy globalUsers shape (id=sessionId, pageId=location.path)', () => {
    mount();
    act(() => fakeSocket.fire('sessions-snapshot', { selfId: 'sA', sessions: [SESSION] }));
    expect(screen.getByTestId('legacy').textContent).toBe('sA:/dashboard');
  });

  it('does not connect when no token is stored', () => {
    localStorage.removeItem('token');
    mount();
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('re-emits set-location on reconnect (rooms are lost server-side on a new session)', () => {
    mount();
    fakeSocket.emit.mockClear();
    act(() => fakeSocket.fire('connect'));
    expect(fakeSocket.emit).toHaveBeenCalledWith('set-location',
      expect.objectContaining({ path: '/dashboard' }));
  });

  it('navigates to the followed session path and clears follow when the session disconnects', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <CollaborationProvider><FollowProbe /></CollaborationProvider>
      </MemoryRouter>
    );
    act(() => fakeSocket.fire('sessions-snapshot', { selfId: 'sA', sessions: [SESSION, OTHER] }));
    act(() => { screen.getByTestId('follow-sB').click(); });
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/project/p1/billing'));
    act(() => fakeSocket.fire('session-left', { sessionId: 'sB' }));
    await waitFor(() => expect(screen.getByTestId('followed').textContent).toBe('none'));
  });

  // Stop-on-manual-navigation is deliberately NOT covered here: jsdom + MemoryRouter
  // makes simulating a real user-driven URL change (as opposed to our own navigate()
  // call) awkward inside this provider-only test. It's covered by the FollowPill RTL
  // test (Task 4) and the e2e suite (Task 9).

  it('sends label only on canvas routes', () => {
    const { unmount } = mount(['/project/p1/page/pg1']);
    const canvasCalls = fakeSocket.emit.mock.calls.filter(c => c[0] === 'set-location');
    expect(canvasCalls.length).toBeGreaterThan(0);
    expect(canvasCalls[canvasCalls.length - 1][1].label).toBe('Projects');
    unmount();

    fakeSocket.emit.mockClear();
    mount(['/project/p1/billing']);
    const nonCanvasCalls = fakeSocket.emit.mock.calls.filter(c => c[0] === 'set-location');
    expect(nonCanvasCalls.length).toBeGreaterThan(0);
    expect(nonCanvasCalls[nonCanvasCalls.length - 1][1].label).toBeUndefined();
  });
});
