// Authenticated realtime core. Replaces the old inline socket block in
// server.ts. Identity comes ONLY from the verified JWT — never from
// client-supplied fields (the old code trusted a client-asserted userId).
import type { Server, Socket } from 'socket.io';
import type Database from 'better-sqlite3';
import { PresenceRegistry } from './presenceRegistry';
import { deviceLabel } from './deviceLabel';
import type { SessionInfo } from './types';
import { applyMeasurementOp, OpRejectedError, hydrateMeasurementRow, type MeasurementOpAction } from './measurementOps';
import type { BroadcastChange } from './changeFeed';
import { getMeta } from '../files';
import type { SheetSessionStore } from './sheetSessions';
import type { SheetFlushEngine } from './sheetFlush';

export interface RealtimeOptions {
  verifyToken: (token: string) => { id: string; username: string; role: string } | null;
  sweepIntervalMs?: number;
  staleAfterMs?: number;
  db?: Database.Database;
  broadcastChange?: BroadcastChange;
  sheetStore?: SheetSessionStore;
  sheetFlush?: SheetFlushEngine;
}

// Duplicated (deliberately) from src/pages/documents/openTarget.ts's
// SHEET_MIMES rather than imported: that module lives under src/pages, a
// client-route directory, and the server has no reason to reach into it for
// two mime strings. Keep both lists in sync if either changes.
const SHEET_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

function isSpreadsheetFile(meta: { kind: string; mime: string }): boolean {
  return meta.kind === 'spreadsheet' || SHEET_MIMES.has(meta.mime);
}

const MAX_SHEET_OP_BYTES = 1 * 1024 * 1024; // 1MB
const MAX_SHEET_STATE_BYTES = 25 * 1024 * 1024; // 25MB

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

    // Sheet (spreadsheet collab) session bookkeeping. Tracked separately from
    // room membership (socket.rooms) because a socket can be IN sheetRoom(id)
    // via set-location without ever having actually joined a collab session
    // (e.g. it navigated there but 'sheet-join' hasn't fired/succeeded yet) —
    // leaves must only fire for fileIds this socket really registered with
    // SheetSessionStore, or store.leave()'s participant count goes negative
    // relative to reality.
    const sheetSessions = new Set<string>();
    socket.data.sheetSessions = sheetSessions;

    // Runs the shared last-participant-leaves sequence for one fileId:
    // store.leave() first (per SheetSessionStore's carried contract — it does
    // not check participants itself), then — only if that was the last
    // participant — flush the pending state to disk and close the session so
    // the next joiner re-arms the first-flush snapshot. Never throws: flush
    // failures are already logged+swallowed inside SheetFlushEngine.
    async function leaveSheetSession(fileId: string): Promise<void> {
      if (!sheetSessions.has(fileId)) return;
      sheetSessions.delete(fileId);
      if (!opts.sheetStore) return;
      const { lastParticipant } = opts.sheetStore.leave(fileId, sessionId);
      if (!lastParticipant) return;
      if (opts.sheetFlush) await opts.sheetFlush.flushFile(fileId);
      opts.sheetStore.closeSession(fileId);
    }

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

      // Moving away from a joined sheet session (including to `undefined`,
      // e.g. back to the dashboard) triggers the leave/flush sequence.
      if (prev?.fileId && prev.fileId !== next.fileId) {
        void leaveSheetSession(prev.fileId);
      }
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

    socket.on('set-editing', (payload: unknown) => {
      let editing: { type: string; id: string } | null = null;
      if (payload && typeof payload === 'object') {
        const p = payload as { type?: unknown; id?: unknown };
        if (typeof p.type === 'string' && p.type && typeof p.id === 'string' && p.id) {
          editing = { type: p.type, id: p.id };
        } else return; // malformed object — ignore
      } else if (payload !== null) return; // only null or {type,id}
      registry.update(sessionId, { editing });
      const s = registry.get(sessionId);
      if (s) io.emit('session-updated', publicSession(s));
    });

    socket.on('heartbeat', () => registry.touch(sessionId));

    // permanent: canvas cursor relay
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

    // Canvas measurement mutation: authoritative write path (WS4). Membership
    // is project-scoped, not page-scoped — a project member may legally op on
    // any page in that project (e.g. paste-across-pages), so the check is
    // "somewhere in the project", not "on this exact page".
    //
    // Full ack error enum for measurement-op / canvas-join:
    //   not_in_project    — sender's socket isn't in this project's room
    //   page_not_found    — pageId doesn't exist under projectId
    //   page_superseded   — target page is a frozen older plan-set revision
    //   invalid_measurement — applyMeasurementOp rejected the measurement's
    //                         own shape/id (bad type/points, cross-page id
    //                         collision) — thrown from inside applyMeasurementOp
    //   invalid_request   — the envelope itself is malformed (missing/wrong-typed
    //                       pageId/projectId/action, or payload isn't an object)
    //   no_db             — server has no database wired (should not happen in prod)
    //   internal          — an unexpected (non-OpRejectedError) exception was
    //                       caught; logged server-side, never rethrown, so a
    //                       transient DB error can't crash the whole process
    socket.on('measurement-op', (payload: unknown, ack?: (res: unknown) => void) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!payload || typeof payload !== 'object') return respond({ ok: false, error: 'invalid_request' });
      const { pageId, projectId, action, measurement, clientTabId } = payload as {
        pageId?: unknown; projectId?: unknown; action?: unknown; measurement?: unknown; clientTabId?: unknown;
      };
      if (
        typeof pageId !== 'string' || !pageId ||
        typeof projectId !== 'string' || !projectId ||
        (action !== 'add' && action !== 'update' && action !== 'delete') ||
        !measurement || typeof measurement !== 'object'
      ) {
        return respond({ ok: false, error: 'invalid_request' });
      }
      if (!socket.rooms.has(projectRoom(projectId))) return respond({ ok: false, error: 'not_in_project' });
      if (!opts.db) return respond({ ok: false, error: 'no_db' });

      const bySessionId = typeof clientTabId === 'string' ? clientTabId : undefined;
      try {
        const { version } = applyMeasurementOp(opts.db, {
          projectId,
          pageId,
          action: action as MeasurementOpAction,
          measurement: measurement as Record<string, unknown> & { id: string },
        });
        respond({ ok: true, version });
        socket.to(projectRoom(projectId)).emit('measurement-applied', {
          pageId, action, measurement, version, bySessionId,
        });
        opts.broadcastChange?.({
          type: 'project',
          id: projectId,
          projectId,
          version,
          action: 'updated',
          byUserId: socket.data.user.id,
          bySessionId,
        });
      } catch (err) {
        if (err instanceof OpRejectedError) return respond({ ok: false, error: err.reason });
        // I1 fix: this handler runs inside a socket event listener, so an
        // uncaught exception here is NOT scoped to the request — it escapes
        // as an uncaught exception on the process and kills the whole
        // (single-process) server. A transient DB error must degrade to a
        // failed ack, never a crash.
        console.error('measurement-op failed', err);
        return respond({ ok: false, error: 'internal' });
      }
    });

    // Canvas join: hydrates a page's current measurements + the project's
    // version for a client opening/reconnecting to the canvas, so it doesn't
    // need a separate REST round-trip to catch up before accepting local ops.
    socket.on('canvas-join', (payload: unknown, ack?: (res: unknown) => void) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!payload || typeof payload !== 'object') return respond({ ok: false, error: 'invalid_request' });
      const { pageId, projectId } = payload as { pageId?: unknown; projectId?: unknown };
      if (typeof pageId !== 'string' || !pageId || typeof projectId !== 'string' || !projectId) {
        return respond({ ok: false, error: 'invalid_request' });
      }
      if (!socket.rooms.has(projectRoom(projectId))) return respond({ ok: false, error: 'not_in_project' });
      if (!opts.db) return respond({ ok: false, error: 'no_db' });

      // I1 fix: same catch-all as measurement-op — an unexpected DB error
      // here must not escape this listener uncaught and crash the process.
      try {
        const page = opts.db.prepare('SELECT id FROM pages WHERE id = ? AND projectId = ?').get(pageId, projectId);
        if (!page) return respond({ ok: false, error: 'page_not_found' });

        const rows = opts.db
          .prepare('SELECT id, takeoffId, type, name, color, points, attrs FROM measurements WHERE pageId = ? ORDER BY sortOrder')
          .all(pageId) as Parameters<typeof hydrateMeasurementRow>[0][];
        const measurements = rows.map(hydrateMeasurementRow);
        const project = opts.db.prepare('SELECT version FROM projects WHERE id = ?').get(projectId) as
          | { version: number }
          | undefined;
        respond({ ok: true, measurements, version: project?.version ?? 0 });
      } catch (err) {
        console.error('canvas-join failed', err);
        respond({ ok: false, error: 'internal' });
      }
    });

    // Shared spreadsheet-editing session (WS5): a client on /tools/sheets
    // joins sheetRoom(fileId) via set-location, then opens a collab session
    // with 'sheet-join'. Ops/state after that are OPAQUE to the server — it
    // never parses them, just journals/relays/folds them (SheetSessionStore)
    // and periodically patches them into the live xlsx bytes (SheetFlushEngine).
    //
    // Full ack error enum for the sheet-* handlers:
    //   not_in_sheet     — sender's socket isn't in this file's sheet room
    //                      (set-location hasn't targeted /tools/sheets?fileId=
    //                      for this fileId)
    //   file_not_found   — fileId doesn't exist in the files table
    //   not_spreadsheet  — file exists but isn't a spreadsheet (kind/mime)
    //   invalid_request  — the envelope is malformed, OR an ops/state payload
    //                      exceeds its size guard (1MB ops / 25MB state)
    //   no_db            — server has no database (or session store/flush
    //                      engine) wired (should not happen in prod)
    //   internal         — an unexpected exception was caught; logged
    //                      server-side, never rethrown
    socket.on('sheet-join', (payload: unknown, ack?: (res: unknown) => void) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!payload || typeof payload !== 'object') return respond({ ok: false, error: 'invalid_request' });
      const { fileId } = payload as { fileId?: unknown };
      if (typeof fileId !== 'string' || !fileId) return respond({ ok: false, error: 'invalid_request' });
      if (!socket.rooms.has(sheetRoom(fileId))) return respond({ ok: false, error: 'not_in_sheet' });
      if (!opts.db || !opts.sheetStore) return respond({ ok: false, error: 'no_db' });

      try {
        const meta = getMeta(opts.db, fileId);
        if (!meta) return respond({ ok: false, error: 'file_not_found' });
        if (!isSpreadsheetFile(meta)) return respond({ ok: false, error: 'not_spreadsheet' });

        const snapshot = opts.sheetStore.join(fileId, sessionId);
        sheetSessions.add(fileId);
        respond({
          ok: true,
          state: snapshot.state,
          ops: snapshot.ops,
          seq: snapshot.seq,
          participants: opts.sheetStore.participants(fileId).length,
        });
      } catch (err) {
        console.error('sheet-join failed', err);
        respond({ ok: false, error: 'internal' });
      }
    });

    socket.on('sheet-op', (payload: unknown, ack?: (res: unknown) => void) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!payload || typeof payload !== 'object') return respond({ ok: false, error: 'invalid_request' });
      const { fileId, ops, clientTabId } = payload as { fileId?: unknown; ops?: unknown; clientTabId?: unknown };
      if (typeof fileId !== 'string' || !fileId || typeof ops !== 'string' || !ops) {
        return respond({ ok: false, error: 'invalid_request' });
      }
      if (Buffer.byteLength(ops, 'utf8') > MAX_SHEET_OP_BYTES) return respond({ ok: false, error: 'invalid_request' });
      if (!socket.rooms.has(sheetRoom(fileId))) return respond({ ok: false, error: 'not_in_sheet' });
      if (!opts.sheetStore) return respond({ ok: false, error: 'no_db' });

      try {
        const seq = opts.sheetStore.appendOps(fileId, ops);
        respond({ ok: true, seq });
        const bySessionId = typeof clientTabId === 'string' ? clientTabId : undefined;
        socket.to(sheetRoom(fileId)).emit('sheet-op-applied', { fileId, ops, seq, bySessionId });
      } catch (err) {
        console.error('sheet-op failed', err);
        respond({ ok: false, error: 'internal' });
      }
    });

    // Debounced-authoritative full state from a client: folds the journal on
    // the server. No broadcast here — peers already applied the individual
    // ops as they arrived via 'sheet-op-applied'; this is purely a server-side
    // compaction so late joiners don't replay a long tail.
    socket.on('sheet-state-sync', (payload: unknown, ack?: (res: unknown) => void) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!payload || typeof payload !== 'object') return respond({ ok: false, error: 'invalid_request' });
      const { fileId, state } = payload as { fileId?: unknown; state?: unknown };
      if (typeof fileId !== 'string' || !fileId || typeof state !== 'string') {
        return respond({ ok: false, error: 'invalid_request' });
      }
      if (Buffer.byteLength(state, 'utf8') > MAX_SHEET_STATE_BYTES) return respond({ ok: false, error: 'invalid_request' });
      if (!socket.rooms.has(sheetRoom(fileId))) return respond({ ok: false, error: 'not_in_sheet' });
      if (!opts.sheetStore) return respond({ ok: false, error: 'no_db' });

      try {
        opts.sheetStore.setState(fileId, state);
        respond({ ok: true });
      } catch (err) {
        console.error('sheet-state-sync failed', err);
        respond({ ok: false, error: 'internal' });
      }
    });

    socket.on('sheet-snapshot', (payload: unknown, ack?: (res: unknown) => void) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!payload || typeof payload !== 'object') return respond({ ok: false, error: 'invalid_request' });
      const { fileId } = payload as { fileId?: unknown };
      if (typeof fileId !== 'string' || !fileId) return respond({ ok: false, error: 'invalid_request' });
      if (!socket.rooms.has(sheetRoom(fileId))) return respond({ ok: false, error: 'not_in_sheet' });
      if (!opts.sheetFlush) return respond({ ok: false, error: 'no_db' });

      opts.sheetFlush.snapshotNow(fileId)
        .then((result) => {
          if (!result.ok) return respond({ ok: false, error: 'internal' });
          respond({ ok: true, version: result.version });
        })
        .catch((err) => {
          console.error('sheet-snapshot failed', err);
          respond({ ok: false, error: 'internal' });
        });
    });

    // Cursor/selection presence within a sheet — relay-only, no ack, no
    // persistence (mirrors 'cursor-move'). name/color come from the sender's
    // OWN session registry entry, never from the client payload.
    socket.on('sheet-presence', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const { fileId, presence } = payload as { fileId?: unknown; presence?: unknown };
      if (typeof fileId !== 'string' || !fileId || !presence || typeof presence !== 'object') return;
      if (!socket.rooms.has(sheetRoom(fileId))) return;
      const s = registry.get(sessionId);
      socket.to(sheetRoom(fileId)).emit('sheet-presence', {
        fileId, sessionId, name: s?.name, color: s?.color, presence,
      });
    });

    socket.on('disconnect', () => {
      const removed = registry.remove(sessionId);
      if (removed) io.emit('session-left', { sessionId });
      for (const fileId of Array.from(sheetSessions)) {
        void leaveSheetSession(fileId);
      }
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
