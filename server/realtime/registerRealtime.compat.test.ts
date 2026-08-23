import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './testHarness';

const PAGE_PATH = '/project/p1/page/pg1';

describe('legacy compat relay', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  beforeEach(async () => { srv = await startRealtimeServer(); });
  afterEach(async () => { await srv.close(); });

  async function joinedClient(username: string) {
    const c = connectClient(srv.port, makeToken({ id: username, username }));
    const snap = await waitFor<{ selfId: string }>(c, 'sessions-snapshot');
    c.emit('set-location', { path: PAGE_PATH, projectId: 'p1', pageId: 'pg1' });
    await new Promise((r) => setTimeout(r, 100));
    return { c, selfId: snap.selfId };
  }

  it('relays cursor-move as user-cursor (sessionId as id) to others in the same path room', async () => {
    const a = await joinedClient('a');
    const b = await joinedClient('b');
    const cursorEvt = waitFor<{ id: string; cursor: { x: number; y: number } }>(b.c, 'user-cursor');
    a.c.emit('cursor-move', { x: 10, y: 20 });
    const evt = await cursorEvt;
    expect(evt).toEqual({ id: a.selfId, cursor: { x: 10, y: 20 } });
    expect(srv.handle.registry.get(a.selfId)?.cursor).toEqual({ x: 10, y: 20 });
    a.c.close(); b.c.close();
  });

  it('relays measurement-update as measurement-sync within the joined room', async () => {
    const a = await joinedClient('a');
    const b = await joinedClient('b');
    const sync = waitFor<{ action: string; measurement: any }>(b.c, 'measurement-sync');
    a.c.emit('measurement-update', { pageId: PAGE_PATH, action: 'add', measurement: { id: 'm1' } });
    const evt = await sync;
    expect(evt).toEqual({ action: 'add', measurement: { id: 'm1' } });
    a.c.close(); b.c.close();
  });

  it('does NOT relay measurement-update into a room the sender never joined', async () => {
    const outsider = connectClient(srv.port, makeToken({ id: 'x', username: 'x' }));
    await waitFor(outsider, 'sessions-snapshot');
    outsider.emit('set-location', { path: '/dashboard' });
    const b = await joinedClient('b');
    let received = false;
    b.c.on('measurement-sync', () => { received = true; });
    outsider.emit('measurement-update', { pageId: PAGE_PATH, action: 'delete', measurement: { id: 'm1' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toBe(false);
    outsider.close(); b.c.close();
  });
});
