// Authenticated realtime core. Replaces the old inline socket block in
// server.ts. Identity comes ONLY from the verified JWT — never from
// client-supplied fields (the old code trusted a client-asserted userId).
import type { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
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
    const sessionId = uuidv4();
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

    socket.emit('sessions-snapshot', {
      selfId: sessionId,
      sessions: registry.all().map(publicSession),
    });
    socket.broadcast.emit('session-joined', publicSession(session));

    socket.on('disconnect', () => {
      const removed = registry.remove(sessionId);
      if (removed) io.emit('session-left', { sessionId });
    });
  });

  return { registry, dispose: () => {} };
}
