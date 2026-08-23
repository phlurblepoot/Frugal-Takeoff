import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { CLIENT_SESSION_ID } from '../utils/clientSession';
import type { SessionView } from '../context/CollaborationContext';

const { fakeSocket } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((evt: string, cb: any) => { (handlers[evt] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((evt: string, cb: any) => { handlers[evt] = (handlers[evt] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (evt: string, ...args: any[]) => (handlers[evt] ?? []).forEach(cb => cb(...args)),
  };
  return { fakeSocket };
});

const ME: SessionView = {
  sessionId: 'me', userId: 'u1', name: 'nathan', role: 'admin', color: '#111',
  device: 'Mac · Chrome', location: null, editing: null, cursor: null, lastActive: 1,
};
const OTHER: SessionView = {
  sessionId: 'other', userId: 'u2', name: 'sam', role: 'user', color: '#000',
  device: 'Mac · Safari', location: null, editing: { type: 'task', id: 't1' }, cursor: null, lastActive: 1,
};

vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, mySessionId: 'me', sessions: [ME, OTHER] }),
}));

import { useCollabEditing, type CollabEditingState } from './useCollabEditing';

let latest: CollabEditingState | null = null;
function Harness({ type, id, isDirty, onFresh }: { type: any; id: string; isDirty: () => boolean; onFresh: () => void }) {
  latest = useCollabEditing({ type, id, isDirty, onFresh });
  return null;
}

const changeEvt = (over: Record<string, unknown> = {}) => ({
  type: 'task', id: 't1', action: 'updated', version: 3, bySessionId: 'other-tab', ...over,
});

describe('useCollabEditing', () => {
  beforeEach(() => {
    latest = null;
    fakeSocket.emit.mockClear();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });

  it('derives othersEditing for the matching entity, empty for a different one', () => {
    render(<Harness type="task" id="t1" isDirty={() => false} onFresh={vi.fn()} />);
    expect(latest?.othersEditing).toEqual([OTHER]);

    render(<Harness type="task" id="t2" isDirty={() => false} onFresh={vi.fn()} />);
    expect(latest?.othersEditing).toEqual([]);
  });

  it('emits set-editing on mount and set-editing null on unmount', () => {
    const { unmount } = render(<Harness type="task" id="t1" isDirty={() => false} onFresh={vi.fn()} />);
    expect(fakeSocket.emit).toHaveBeenCalledWith('set-editing', { type: 'task', id: 't1' });
    unmount();
    expect(fakeSocket.emit).toHaveBeenCalledWith('set-editing', null);
  });

  it('pristine: a foreign entity-changed for this type+id calls onFresh immediately, leaves remoteChange null', () => {
    const onFresh = vi.fn();
    render(<Harness type="task" id="t1" isDirty={() => false} onFresh={onFresh} />);
    act(() => { fakeSocket.fire('entity-changed', changeEvt()); });
    expect(onFresh).toHaveBeenCalledTimes(1);
    expect(latest?.remoteChange).toBeNull();
  });

  it('dirty: a foreign entity-changed sets remoteChange (not onFresh); keepMine adopts its version and clears the banner', () => {
    const onFresh = vi.fn();
    render(<Harness type="task" id="t1" isDirty={() => true} onFresh={onFresh} />);
    const ev = changeEvt();
    act(() => { fakeSocket.fire('entity-changed', ev); });
    expect(onFresh).not.toHaveBeenCalled();
    expect(latest?.remoteChange).toEqual(ev);

    act(() => { latest?.keepMine(); });
    expect(latest?.keepMineVersion).toBe(ev.version);
    expect(latest?.remoteChange).toBeNull();
  });

  it('ignores self-echo entity-changed events (bySessionId === CLIENT_SESSION_ID)', () => {
    const onFresh = vi.fn();
    render(<Harness type="task" id="t1" isDirty={() => false} onFresh={onFresh} />);
    act(() => { fakeSocket.fire('entity-changed', changeEvt({ bySessionId: CLIENT_SESSION_ID })); });
    expect(onFresh).not.toHaveBeenCalled();
    expect(latest?.remoteChange).toBeNull();
  });
});
