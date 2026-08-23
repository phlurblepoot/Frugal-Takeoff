// Authenticated realtime core. Replaces the old inline socket block in
// server.ts. Identity comes ONLY from the verified JWT — never from
// client-supplied fields (the old code trusted a client-asserted userId).
import type { Server, Socket } from 'socket.io';
import { PresenceRegistry } from './presenceRegistry';
import { deviceLabel } from './deviceLabel';
import type { SessionInfo } from './types';

export interface RealtimeOptions {
  verifyToken: (token: string) => { id: string; username: string; role: string } | null;
  sweepIntervalMs?: number;
  staleAfterMs?: number;
}

export interface RealtimeHandle {
  registry: PresenceRegistry;
  dispose: () => void;
}

const DEFAULT_COLOR = '#3b82f6';

// Public projection of a session (all of SessionInfo is safe to share today,
// but keep the seam so private fields can be added later).
function publicSession(s: SessionInfo): SessionInfo {
  return { ...s };
}

export const projectRoom = (id: string) => `project:${id}`;
export const pageRoom = (id: string) => `page:${id}`;
export const sheetRoom = (id: string) => `sheet:${id}`;
export const pathRoom = (path: string) => `path:${path}`;

function roomsForLocation(loc: { path: string; projectId?: string; pageId?: string; fileId?: string }): string[] {
  const rooms = [pathRoom(loc.path)];
  if (loc.projectId) rooms.push(projectRoom(loc.projectId));
  if (loc.pageId) rooms.push(pageRoom(loc.pageId));
  if (loc.fileId) rooms.push(sheetRoom(loc.fileId));
  return rooms;
}

export function registerRealtime(io: Server, opts: RealtimeOptions): RealtimeHandle {
  const registry = new PresenceRegistry();

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = typeof token === 'string' && token ? opts.verifyToken(token) : null;
    if (!payload) return next(new Error('unauthorized'));
    socket.data.user = { id: String(payload.id), name: String(payload.username), role: String(payload.role) };
    next();
  });

  io.on('connection', (socket: Socket) => {
    // socket.id doubles as the sessionId: it's server-generated and unique per
    // connection (our model is one connection = one session), and legacy
    // client consumers self-identify by comparing against socket.id.
    const sessionId = socket.id;
    socket.data.sessionId = sessionId;
    const auth = socket.handshake.auth ?? {};
    const session: SessionInfo = {
      sessionId,
      userId: socket.data.user.id,
      name: socket.data.user.name,
      role: socket.data.user.role,
      color: typeof auth.color === 'string' ? auth.color : DEFAULT_COLOR,
      device: deviceLabel(socket.handshake.headers['user-agent']),
      location: null,
      editing: null,
      cursor: null,
      lastActive: Date.now(),
    };
    registry.add(session);

    // Engine-level packets (incl. ping/pong) are sent from message handlers,
    // which browsers do NOT throttle in hidden tabs — unlike the client's
    // 25s heartbeat timer. Touching here makes the sweep a true last resort
    // for zombie connections instead of a killer of backgrounded tabs.
    socket.conn.on('packet', () => registry.touch(sessionId));

    socket.emit('sessions-snapshot', {
      selfId: sessionId,
      sessions: registry.all().map(publicSession),
    });
    socket.broadcast.emit('session-joined', publicSession(session));

    socket.on('set-location', (loc: unknown) => {
      if (!loc || typeof loc !== 'object' || typeof (loc as any).path !== 'string') return;
      const l = loc as { path: string; projectId?: string; section?: string; pageId?: string; fileId?: string; label?: string };
      const prev = registry.get(sessionId)?.location;
      if (prev) for (const room of roomsForLocation(prev)) socket.leave(room);
      const next = {
        path: l.path,
        projectId: typeof l.projectId === 'string' ? l.projectId : undefined,
        section: typeof l.section === 'string' ? l.section : undefined,
        pageId: typeof l.pageId === 'string' ? l.pageId : undefined,
        fileId: typeof l.fileId === 'string' ? l.fileId : undefined,
        label: typeof l.label === 'string' ? l.label : undefined,
      };
      for (const room of roomsForLocation(next)) socket.join(room);
      registry.setLocation(sessionId, next);
      const s = registry.get(sessionId);
      if (s) io.emit('session-updated', publicSession(s));
    });

    socket.on('update-user', (patch: unknown) => {
      if (!patch || typeof patch !== 'object') return;
      const p = patch as { name?: unknown; color?: unknown };
      const allowed: { name?: string; color?: string } = {};
      if (typeof p.name === 'string' && p.name) allowed.name = p.name;
      if (typeof p.color === 'string' && p.color) allowed.color = p.color;
      registry.update(sessionId, allowed);
      const s = registry.get(sessionId);
      if (s) io.emit('session-updated', publicSession(s));
    });

    socket.on('heartbeat', () => registry.touch(sessionId));

    // ---- WS1 compat shim (removed in WS4): legacy canvas events ----
    socket.on('cursor-move', (pos: unknown) => {
      if (!pos || typeof pos !== 'object') return;
      const { x, y } = pos as { x?: unknown; y?: unknown };
      if (typeof x !== 'number' || typeof y !== 'number') return;
      registry.update(sessionId, { cursor: { x, y } });
      const s = registry.get(sessionId);
      if (s?.location) {
        socket.to(pathRoom(s.location.path)).emit('user-cursor', { id: sessionId, cursor: { x, y } });
      }
    });

    socket.on('measurement-update', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const { pageId, action, measurement } = payload as { pageId?: unknown; action?: unknown; measurement?: unknown };
      if (typeof pageId !== 'string' || typeof action !== 'string') return;
      const room = pathRoom(pageId);
      if (!socket.rooms.has(room)) return; // membership enforced (old code relayed blindly)
      registry.touch(sessionId);
      socket.to(room).emit('measurement-sync', { action, measurement });
    });
    // ---- end compat shim ----

    socket.on('disconnect', () => {
      const removed = registry.remove(sessionId);
      if (removed) io.emit('session-left', { sessionId });
    });
  });

  const sweepIntervalMs = opts.sweepIntervalMs ?? 30_000;
  const staleAfterMs = opts.staleAfterMs ?? 60_000;
  const sweepTimer = setInterval(() => {
    const swept = registry.sweep(staleAfterMs);
    for (const s of swept) {
      io.emit('session-left', { sessionId: s.sessionId });
      for (const [, sock] of io.of('/').sockets) {
        if (sock.data.sessionId === s.sessionId) { sock.disconnect(true); break; }
      }
    }
  }, sweepIntervalMs);
  // unref() so a leaked handle can never keep the process (or vitest) alive
  sweepTimer.unref?.();

  return { registry, dispose: () => clearInterval(sweepTimer) };
}
