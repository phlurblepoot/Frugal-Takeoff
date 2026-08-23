import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
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

describe('CollaborationContext', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'tok123');
    localStorage.setItem('user', JSON.stringify({ id: 'u1', username: 'nathan' }));
    ioMock.mockClear(); fakeSocket.emit.mockClear();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });

  function mount() {
    return render(
      <MemoryRouter initialEntries={['/dashboard']}>
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
});
