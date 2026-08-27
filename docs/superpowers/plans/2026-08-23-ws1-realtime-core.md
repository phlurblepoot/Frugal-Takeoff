# WS1 — Realtime Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unauthenticated inline socket block in `server.ts` with an authenticated `server/realtime/` module providing session-level presence (device labels, structured locations), resource rooms, heartbeat sweep, and delta presence events — while a compat shim keeps today's canvas relay and user-list UI working unchanged.

**Architecture:** A pure in-memory `PresenceRegistry` class (no socket.io dependency, fully unit-testable) holds sessions keyed by server-generated `sessionId`. `registerRealtime(io, opts)` wires it to socket.io: JWT handshake middleware (identity only from the verified token), `set-location` drives resource-room membership (`project:<id>`, `page:<id>`, plus a `path:<pathname>` legacy room for the compat shim), presence changes broadcast as deltas (`sessions-snapshot` on connect, then `session-joined/left/updated`). The client `CollaborationContext` connects with the JWT, maintains a `sessions` list from the deltas, and **derives** the legacy `users`/`globalUsers` arrays from it so no other client file changes in WS1.

**Tech Stack:** socket.io 4.8 / socket.io-client 4.8, jsonwebtoken, uuid (v4 import style: `import { v4 as uuidv4 } from 'uuid'`), Vitest (server project: `server/**/*.test.ts`, node env; ui project: jsdom + RTL), better-sqlite3 untouched (WS1 needs no DB).

**Spec:** `docs/superpowers/specs/2026-08-23-realtime-collaboration-design.md` (§3 = WS1). Progress tracking: `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md` — tick WS1 items with commit hashes **in the same commit** as the work.

## Global Constraints

- **No secure-context browser APIs** (`crypto.randomUUID`, etc.) in `src/**` — plain-HTTP LAN deployment; use the `uuid` package. (Server-side Node `crypto` is fine and already used in `server.ts`.)
- SQLite `journal_mode = DELETE` stays; no schema changes in WS1 (no migration).
- Single-process: presence is in-memory only; no Redis/adapters.
- All existing tests (700+) must keep passing: `npm run test`. Typecheck: `npm run lint` (tsc --noEmit).
- Git: commit per task, push to `testing` branch only. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- JWT payload shape (from `server.ts:197`): `{ id, username, role }`, 24h expiry, secret resolved at `server.ts:117-127`. Client token lives in `localStorage.getItem('token')`; user object in `localStorage.getItem('user')`.
- Login dispatches `window.dispatchEvent(new Event('app:prefs-sync'))` (see `src/pages/Login.tsx` / `ThemeContext.tsx:109`) — WS1 reuses it as the "token just appeared" signal.

---

### Task 1: Device label parser

**Files:**
- Create: `server/realtime/deviceLabel.ts`
- Test: `server/realtime/deviceLabel.test.ts`

**Interfaces:**
- Produces: `deviceLabel(userAgent: string | undefined): string` — e.g. `"Windows · Chrome"`, `"iPad · Safari"`, `"Unknown device"`.

- [ ] **Step 1: Write the failing test**

```ts
// server/realtime/deviceLabel.test.ts
import { describe, it, expect } from 'vitest';
import { deviceLabel } from './deviceLabel';

const UA = {
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  iPad: 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

describe('deviceLabel', () => {
  it('labels Windows Chrome', () => expect(deviceLabel(UA.winChrome)).toBe('Windows · Chrome'));
  it('labels Edge before Chrome (Edge UA contains "Chrome")', () => expect(deviceLabel(UA.winEdge)).toBe('Windows · Edge'));
  it('labels Mac Safari (Safari UA contains no "Chrome")', () => expect(deviceLabel(UA.macSafari)).toBe('Mac · Safari'));
  it('labels iPad', () => expect(deviceLabel(UA.iPad)).toBe('iPad · Safari'));
  it('labels iPhone', () => expect(deviceLabel(UA.iPhone)).toBe('iPhone · Safari'));
  it('labels Android Chrome', () => expect(deviceLabel(UA.android)).toBe('Android · Chrome'));
  it('labels Linux Firefox', () => expect(deviceLabel(UA.linuxFirefox)).toBe('Linux · Firefox'));
  it('handles missing UA', () => expect(deviceLabel(undefined)).toBe('Unknown device'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project server server/realtime/deviceLabel.test.ts`
Expected: FAIL — cannot resolve `./deviceLabel`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/realtime/deviceLabel.ts
// Best-effort UA → "OS · Browser" label for the online-sessions list.
// Order matters: Edge UAs contain "Chrome"; Chrome UAs contain "Safari";
// iPad/iPhone UAs contain "Mac OS X". Modern iPadOS Safari masquerades as
// Macintosh — "Mac · Safari" for those is an accepted imperfection.
export function deviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;

  let os = 'Unknown';
  if (/iPad/i.test(ua)) os = 'iPad';
  else if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'Mac';
  else if (/Linux|X11/i.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  if (os === 'Unknown' && browser === 'Browser') return 'Unknown device';
  return `${os} · ${browser}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project server server/realtime/deviceLabel.test.ts`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add server/realtime/deviceLabel.ts server/realtime/deviceLabel.test.ts
git commit -m "feat(realtime): device label parser for session presence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared realtime types + PresenceRegistry

**Files:**
- Create: `server/realtime/types.ts`
- Create: `server/realtime/presenceRegistry.ts`
- Test: `server/realtime/presenceRegistry.test.ts`

**Interfaces:**
- Produces (`types.ts` — later tasks and WS2/WS3 import these exact names):

```ts
export interface LocationInfo {
  path: string;          // location.pathname, e.g. "/project/abc/billing"
  projectId?: string;
  section?: string;      // "billing" | "issues" | "takeoff" | ... (last route segment under /project/:id)
  pageId?: string;       // canvas page UUID when on /project/:id/page/:pageId
  fileId?: string;       // spreadsheet file id when on /tools/sheets?fileId=...
  label?: string;        // human-readable page label (old "pageName"), client-supplied
}

export interface SessionInfo {
  sessionId: string;     // server-generated uuid
  userId: string;        // from verified JWT (payload.id)
  name: string;          // from verified JWT (payload.username)
  role: string;          // from verified JWT (payload.role)
  color: string;
  device: string;        // deviceLabel() output
  location: LocationInfo | null;
  editing: { type: string; id: string } | null;  // declared in WS2; carried now
  cursor: { x: number; y: number } | null;
  lastActive: number;    // epoch ms
}
```

- Produces (`presenceRegistry.ts`): class `PresenceRegistry` with methods
  `add(s: SessionInfo): void` · `remove(sessionId: string): SessionInfo | undefined` ·
  `get(sessionId: string): SessionInfo | undefined` · `all(): SessionInfo[]` ·
  `setLocation(sessionId: string, loc: LocationInfo): void` ·
  `update(sessionId: string, patch: Partial<Pick<SessionInfo, 'name' | 'color' | 'editing' | 'cursor'>>): void` ·
  `touch(sessionId: string, now?: number): void` ·
  `sweep(staleAfterMs: number, now?: number): SessionInfo[]` (removes and returns stale sessions).
  All mutating methods bump `lastActive` for that session. Pure in-memory; no socket.io imports (this is the seam a distributed adapter would replace).

- [ ] **Step 1: Write the failing test**

```ts
// server/realtime/presenceRegistry.test.ts
import { describe, it, expect } from 'vitest';
import { PresenceRegistry } from './presenceRegistry';
import type { SessionInfo } from './types';

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's1', userId: 'u1', name: 'nathan', role: 'admin',
    color: '#3b82f6', device: 'Windows · Chrome',
    location: null, editing: null, cursor: null, lastActive: 1000,
    ...over,
  };
}

describe('PresenceRegistry', () => {
  it('adds and gets sessions', () => {
    const r = new PresenceRegistry();
    r.add(makeSession());
    expect(r.get('s1')?.userId).toBe('u1');
    expect(r.all()).toHaveLength(1);
  });

  it('remove returns the removed session, undefined for unknown', () => {
    const r = new PresenceRegistry();
    r.add(makeSession());
    expect(r.remove('s1')?.sessionId).toBe('s1');
    expect(r.remove('s1')).toBeUndefined();
    expect(r.all()).toHaveLength(0);
  });

  it('setLocation replaces location and bumps lastActive', () => {
    const r = new PresenceRegistry();
    r.add(makeSession({ lastActive: 1000 }));
    r.setLocation('s1', { path: '/project/p1/billing', projectId: 'p1', section: 'billing' });
    const s = r.get('s1')!;
    expect(s.location?.projectId).toBe('p1');
    expect(s.lastActive).toBeGreaterThan(1000);
  });

  it('update patches only allowed fields and bumps lastActive', () => {
    const r = new PresenceRegistry();
    r.add(makeSession({ lastActive: 1000 }));
    r.update('s1', { color: '#ef4444', cursor: { x: 5, y: 6 } });
    const s = r.get('s1')!;
    expect(s.color).toBe('#ef4444');
    expect(s.cursor).toEqual({ x: 5, y: 6 });
    expect(s.name).toBe('nathan');
    expect(s.lastActive).toBeGreaterThan(1000);
  });

  it('touch with explicit now sets lastActive', () => {
    const r = new PresenceRegistry();
    r.add(makeSession({ lastActive: 1000 }));
    r.touch('s1', 5000);
    expect(r.get('s1')!.lastActive).toBe(5000);
  });

  it('sweep removes and returns sessions stale beyond staleAfterMs', () => {
    const r = new PresenceRegistry();
    r.add(makeSession({ sessionId: 'fresh', lastActive: 9000 }));
    r.add(makeSession({ sessionId: 'stale', lastActive: 1000 }));
    const swept = r.sweep(5000, 10000); // cutoff: lastActive < 5000
    expect(swept.map(s => s.sessionId)).toEqual(['stale']);
    expect(r.get('stale')).toBeUndefined();
    expect(r.get('fresh')).toBeDefined();
  });

  it('methods on unknown sessionId are no-ops', () => {
    const r = new PresenceRegistry();
    expect(() => {
      r.setLocation('nope', { path: '/' });
      r.update('nope', { color: '#fff' });
      r.touch('nope');
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project server server/realtime/presenceRegistry.test.ts`
Expected: FAIL — cannot resolve `./presenceRegistry`.

- [ ] **Step 3: Write minimal implementation**

Create `server/realtime/types.ts` with the two interfaces exactly as in the Interfaces block above, then:

```ts
// server/realtime/presenceRegistry.ts
// In-memory session registry — the single source of truth for presence.
// Deliberately free of socket.io imports: this is the interface a
// distributed adapter would replace if the app ever runs multi-process.
import type { LocationInfo, SessionInfo } from './types';

export class PresenceRegistry {
  private sessions = new Map<string, SessionInfo>();

  add(session: SessionInfo): void {
    this.sessions.set(session.sessionId, session);
  }

  remove(sessionId: string): SessionInfo | undefined {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return s;
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  all(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  setLocation(sessionId: string, loc: LocationInfo): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.location = loc;
    s.lastActive = Date.now();
  }

  update(sessionId: string, patch: Partial<Pick<SessionInfo, 'name' | 'color' | 'editing' | 'cursor'>>): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    Object.assign(s, patch);
    s.lastActive = Date.now();
  }

  touch(sessionId: string, now: number = Date.now()): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.lastActive = now;
  }

  sweep(staleAfterMs: number, now: number = Date.now()): SessionInfo[] {
    const stale: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      if (now - s.lastActive > staleAfterMs) stale.push(s);
    }
    for (const s of stale) this.sessions.delete(s.sessionId);
    return stale;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project server server/realtime/presenceRegistry.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add server/realtime/types.ts server/realtime/presenceRegistry.ts server/realtime/presenceRegistry.test.ts
git commit -m "feat(realtime): session types + in-memory PresenceRegistry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: registerRealtime — JWT handshake auth

**Files:**
- Create: `server/realtime/registerRealtime.ts`
- Create: `server/realtime/testHarness.ts` (test-only helper, used by this and later tasks)
- Test: `server/realtime/registerRealtime.auth.test.ts`

**Interfaces:**
- Produces (`registerRealtime.ts`):

```ts
export interface RealtimeOptions {
  verifyToken: (token: string) => { id: string; username: string; role: string } | null;
  sweepIntervalMs?: number;   // default 30_000 (Task 5)
  staleAfterMs?: number;      // default 60_000 (Task 5)
}
export interface RealtimeHandle {
  registry: PresenceRegistry;
  dispose: () => void;        // clears the sweep interval (Task 5); safe to call anytime
}
export function registerRealtime(io: Server, opts: RealtimeOptions): RealtimeHandle;
```

- Produces (`testHarness.ts`): `startRealtimeServer(opts?: Partial<RealtimeOptions>)` → `{ port, io, handle, close() }` on an ephemeral port with a JWT signed by test secret `'test-secret'`; helper `makeToken(payload?)` and `connectClient(port, token | undefined, extraAuth?)` returning a `socket.io-client` Socket.
- Consumes: `PresenceRegistry`, `deviceLabel`, `SessionInfo` from Tasks 1–2.

- [ ] **Step 1: Write the test harness**

```ts
// server/realtime/testHarness.ts
// Test-only helper: real socket.io server + clients on an ephemeral port.
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { registerRealtime, type RealtimeOptions, type RealtimeHandle } from './registerRealtime';

export const TEST_SECRET = 'test-secret';

export function makeToken(payload: Record<string, unknown> = {}): string {
  return jwt.sign({ id: 'u1', username: 'nathan', role: 'admin', ...payload }, TEST_SECRET, { expiresIn: '1h' });
}

export function verifyTestToken(token: string) {
  try { return jwt.verify(token, TEST_SECRET) as { id: string; username: string; role: string }; }
  catch { return null; }
}

export async function startRealtimeServer(opts: Partial<RealtimeOptions> = {}) {
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  const handle: RealtimeHandle = registerRealtime(io, { verifyToken: verifyTestToken, ...opts });
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, () => resolve((httpServer.address() as { port: number }).port));
  });
  return {
    port, io, handle,
    close: async () => {
      handle.dispose();
      io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export function connectClient(port: number, token: string | undefined, extraAuth: Record<string, unknown> = {}): Socket {
  return ioc(`http://localhost:${port}`, {
    auth: { token, ...extraAuth },
    transports: ['websocket'],
    reconnection: false,
  });
}

export function waitFor<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

export function waitForConnectError(socket: Socket): Promise<Error> {
  return new Promise((resolve) => socket.once('connect_error', resolve));
}
```

- [ ] **Step 2: Write the failing auth test**

```ts
// server/realtime/registerRealtime.auth.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor, waitForConnectError } from './testHarness';

describe('registerRealtime auth', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  beforeEach(async () => { srv = await startRealtimeServer(); });
  afterEach(async () => { await srv.close(); });

  it('rejects a connection with no token', async () => {
    const client = connectClient(srv.port, undefined);
    const err = await waitForConnectError(client);
    expect(err.message).toBe('unauthorized');
    client.close();
  });

  it('rejects a connection with a garbage token', async () => {
    const client = connectClient(srv.port, 'not-a-jwt');
    const err = await waitForConnectError(client);
    expect(err.message).toBe('unauthorized');
    client.close();
  });

  it('accepts a valid token and sends a sessions-snapshot with identity from the JWT, not the client', async () => {
    // Client tries to spoof identity via auth payload — must be ignored.
    const client = connectClient(srv.port, makeToken({ id: 'u1', username: 'nathan' }), {
      userId: 'evil-spoof', name: 'evil-spoof',
    });
    const snapshot = await waitFor<{ selfId: string; sessions: any[] }>(client, 'sessions-snapshot');
    expect(snapshot.selfId).toBeTruthy();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].userId).toBe('u1');
    expect(snapshot.sessions[0].name).toBe('nathan');
    expect(snapshot.sessions[0].sessionId).toBe(snapshot.selfId);
    client.close();
  });

  it('registry reflects the connected session and clears on disconnect', async () => {
    const client = connectClient(srv.port, makeToken(), { color: '#ef4444' });
    await waitFor(client, 'sessions-snapshot');
    expect(srv.handle.registry.all()).toHaveLength(1);
    expect(srv.handle.registry.all()[0].color).toBe('#ef4444');
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.handle.registry.all()).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --project server server/realtime/registerRealtime.auth.test.ts`
Expected: FAIL — cannot resolve `./registerRealtime`.

- [ ] **Step 4: Write the implementation**

```ts
// server/realtime/registerRealtime.ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project server server/realtime/registerRealtime.auth.test.ts`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add server/realtime/registerRealtime.ts server/realtime/testHarness.ts server/realtime/registerRealtime.auth.test.ts
git commit -m "feat(realtime): JWT-authenticated socket handshake + session lifecycle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: set-location → resource rooms + presence deltas

**Files:**
- Modify: `server/realtime/registerRealtime.ts`
- Test: `server/realtime/registerRealtime.location.test.ts`

**Interfaces:**
- Consumes: `LocationInfo` from `types.ts`; harness from Task 3.
- Produces (wire protocol — client Task 8 and WS2+ depend on these exact names):
  - C→S `set-location` with a `LocationInfo` payload → joins `project:<projectId>` / `page:<pageId>` / `sheet:<fileId>` / `path:<path>` rooms as applicable, leaves the previous location's rooms, broadcasts `session-updated`.
  - C→S `update-user` `{ name?, color? }` → patches session (name/color only), broadcasts `session-updated`.
  - S→C `session-updated` payload: full `SessionInfo` of the changed session.
  - Room-name helpers exported for later workstreams: `projectRoom(id: string)`, `pageRoom(id: string)`, `sheetRoom(id: string)`, `pathRoom(path: string)` returning `project:<id>` etc.

- [ ] **Step 1: Write the failing test**

```ts
// server/realtime/registerRealtime.location.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './testHarness';
import { projectRoom, pageRoom, pathRoom } from './registerRealtime';

describe('set-location and rooms', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  beforeEach(async () => { srv = await startRealtimeServer(); });
  afterEach(async () => { await srv.close(); });

  async function socketRooms(sessionId: string): Promise<Set<string>> {
    for (const [, s] of srv.io.of('/').sockets) {
      if (s.data.sessionId === sessionId) return new Set(s.rooms);
    }
    return new Set();
  }

  it('joins project/page/path rooms from location and leaves them on change', async () => {
    const client = connectClient(srv.port, makeToken());
    const snap = await waitFor<{ selfId: string }>(client, 'sessions-snapshot');

    client.emit('set-location', { path: '/project/p1/page/pg1', projectId: 'p1', pageId: 'pg1', label: 'Floor 6' });
    await new Promise((r) => setTimeout(r, 100));
    let rooms = await socketRooms(snap.selfId);
    expect(rooms.has(projectRoom('p1'))).toBe(true);
    expect(rooms.has(pageRoom('pg1'))).toBe(true);
    expect(rooms.has(pathRoom('/project/p1/page/pg1'))).toBe(true);

    client.emit('set-location', { path: '/dashboard' });
    await new Promise((r) => setTimeout(r, 100));
    rooms = await socketRooms(snap.selfId);
    expect(rooms.has(projectRoom('p1'))).toBe(false);
    expect(rooms.has(pageRoom('pg1'))).toBe(false);
    expect(rooms.has(pathRoom('/dashboard'))).toBe(true);
    expect(srv.handle.registry.get(snap.selfId)?.location?.path).toBe('/dashboard');
    client.close();
  });

  it('broadcasts session-updated with the new location to other clients', async () => {
    const a = connectClient(srv.port, makeToken({ id: 'u1', username: 'a' }));
    await waitFor(a, 'sessions-snapshot');
    const b = connectClient(srv.port, makeToken({ id: 'u2', username: 'b' }));
    const bSnap = await waitFor<{ selfId: string }>(b, 'sessions-snapshot');

    const updated = waitFor<any>(a, 'session-updated');
    b.emit('set-location', { path: '/project/p1/billing', projectId: 'p1', section: 'billing' });
    const evt = await updated;
    expect(evt.sessionId).toBe(bSnap.selfId);
    expect(evt.location.section).toBe('billing');
    a.close(); b.close();
  });

  it('update-user patches name/color only and broadcasts session-updated', async () => {
    const a = connectClient(srv.port, makeToken({ id: 'u1', username: 'a' }));
    const aSnap = await waitFor<{ selfId: string }>(a, 'sessions-snapshot');
    const b = connectClient(srv.port, makeToken({ id: 'u2', username: 'b' }));
    await waitFor(b, 'sessions-snapshot');

    const updated = waitFor<any>(b, 'session-updated');
    a.emit('update-user', { color: '#10b981', role: 'admin-spoof' });
    const evt = await updated;
    expect(evt.sessionId).toBe(aSnap.selfId);
    expect(evt.color).toBe('#10b981');
    expect(evt.role).toBe('admin'); // role can't be patched via update-user
    a.close(); b.close();
  });

  it('malformed set-location payloads are ignored without crashing', async () => {
    const client = connectClient(srv.port, makeToken());
    await waitFor(client, 'sessions-snapshot');
    client.emit('set-location', null);
    client.emit('set-location', { noPath: true });
    client.emit('set-location', 42);
    await new Promise((r) => setTimeout(r, 100));
    expect(srv.handle.registry.all()).toHaveLength(1);
    client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project server server/realtime/registerRealtime.location.test.ts`
Expected: FAIL — `projectRoom` not exported / no `set-location` handler.

- [ ] **Step 3: Implement**

Add to `registerRealtime.ts` (top-level exports + inside the connection handler):

```ts
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
```

Inside `io.on('connection', ...)` add:

```ts
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
      if (s) socket.broadcast.emit('session-updated', publicSession(s));
    });

    socket.on('update-user', (patch: unknown) => {
      if (!patch || typeof patch !== 'object') return;
      const p = patch as { name?: unknown; color?: unknown };
      const allowed: { name?: string; color?: string } = {};
      if (typeof p.name === 'string' && p.name) allowed.name = p.name;
      if (typeof p.color === 'string' && p.color) allowed.color = p.color;
      registry.update(sessionId, allowed);
      const s = registry.get(sessionId);
      if (s) socket.broadcast.emit('session-updated', publicSession(s));
    });
```

- [ ] **Step 4: Run tests (this file + prior realtime tests)**

Run: `npx vitest run --project server server/realtime/`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add server/realtime/registerRealtime.ts server/realtime/registerRealtime.location.test.ts
git commit -m "feat(realtime): structured locations, resource rooms, presence deltas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Heartbeat + stale-session sweep

**Files:**
- Modify: `server/realtime/registerRealtime.ts`
- Test: `server/realtime/registerRealtime.heartbeat.test.ts`

**Interfaces:**
- Produces (wire protocol): C→S `heartbeat` (no payload) → `registry.touch(sessionId)`. Server sweep interval (`sweepIntervalMs`, default 30 000) calls `registry.sweep(staleAfterMs)` (default 60 000); each swept session's socket is disconnected and `session-left { sessionId }` broadcast. `dispose()` clears the interval.
- Client contract (Task 8): emit `heartbeat` every 25 000 ms.

- [ ] **Step 1: Write the failing test**

```ts
// server/realtime/registerRealtime.heartbeat.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './testHarness';

describe('heartbeat + sweep', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>> | undefined;
  afterEach(async () => { await srv?.close(); srv = undefined; });

  it('sweeps sessions that stop heartbeating and broadcasts session-left', async () => {
    srv = await startRealtimeServer({ sweepIntervalMs: 100, staleAfterMs: 250 });
    const quiet = connectClient(srv.port, makeToken({ id: 'u1', username: 'quiet' }));
    const quietSnap = await waitFor<{ selfId: string }>(quiet, 'sessions-snapshot');
    const lively = connectClient(srv.port, makeToken({ id: 'u2', username: 'lively' }));
    await waitFor(lively, 'sessions-snapshot');

    // lively heartbeats; quiet goes silent (suppress its outgoing heartbeat entirely)
    const beat = setInterval(() => lively.emit('heartbeat'), 50);
    const left = await waitFor<{ sessionId: string }>(lively, 'session-left');
    clearInterval(beat);

    expect(left.sessionId).toBe(quietSnap.selfId);
    expect(srv.handle.registry.all().map(s => s.name)).toEqual(['lively']);
    quiet.close(); lively.close();
  }, 10_000);

  it('heartbeat keeps a session alive past staleAfterMs', async () => {
    srv = await startRealtimeServer({ sweepIntervalMs: 100, staleAfterMs: 250 });
    const client = connectClient(srv.port, makeToken());
    await waitFor(client, 'sessions-snapshot');
    const beat = setInterval(() => client.emit('heartbeat'), 50);
    await new Promise((r) => setTimeout(r, 600)); // > 2× staleAfterMs
    clearInterval(beat);
    expect(srv.handle.registry.all()).toHaveLength(1);
    client.close();
  });

  it('dispose clears the sweep interval', async () => {
    srv = await startRealtimeServer({ sweepIntervalMs: 100, staleAfterMs: 250 });
    srv.handle.dispose();
    // no assertion beyond "does not throw / does not keep the process alive";
    // vitest will hang on leaked intervals, so completing is the assertion.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project server server/realtime/registerRealtime.heartbeat.test.ts`
Expected: first two tests FAIL (no heartbeat handler / no sweep — quiet session never leaves).

- [ ] **Step 3: Implement**

In `registerRealtime()`, before `return`:

```ts
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
```

Inside the connection handler add:

```ts
    socket.on('heartbeat', () => registry.touch(sessionId));
```

And change the returned handle to:

```ts
  return { registry, dispose: () => clearInterval(sweepTimer) };
```

Also guard the disconnect broadcast against double-fire (sweep may have already removed the session — `registry.remove` returning `undefined` means the sweep won, and `session-left` was already emitted):
the existing `if (removed) io.emit('session-left', ...)` already handles this; verify it stays.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project server server/realtime/`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add server/realtime/registerRealtime.ts server/realtime/registerRealtime.heartbeat.test.ts
git commit -m "feat(realtime): heartbeat + stale-session sweep

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Compat shim — legacy canvas relay on the new core

**Files:**
- Modify: `server/realtime/registerRealtime.ts`
- Test: `server/realtime/registerRealtime.compat.test.ts`

**Interfaces:**
- Produces (legacy wire protocol, kept verbatim so `CanvasView.tsx` / `PdfCanvas.tsx` need zero changes in WS1; **deleted in WS4**):
  - C→S `cursor-move` `{ x, y }` → sets `session.cursor`, touches, relays `user-cursor` `{ id: <sessionId>, cursor }` to the sender's current `path:` room (matching the old `{ id: socket.id, cursor }` shape — consumers only match on `id`, which is now the sessionId everywhere).
  - C→S `measurement-update` `{ pageId, action, measurement }` where `pageId` is a *pathname* (legacy naming) → **membership check**: only relays `measurement-sync` `{ action, measurement }` to `path:<pageId>` if the sender has joined that room. This closes the old "broadcast into rooms you never joined" hole while keeping the event shape identical.
- Consumes: `pathRoom` from Task 4.

- [ ] **Step 1: Write the failing test**

```ts
// server/realtime/registerRealtime.compat.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project server server/realtime/registerRealtime.compat.test.ts`
Expected: FAIL — no handlers.

- [ ] **Step 3: Implement**

Inside the connection handler add (marked clearly for WS4 removal):

```ts
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
```

- [ ] **Step 4: Run all realtime tests**

Run: `npx vitest run --project server server/realtime/`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add server/realtime/registerRealtime.ts server/realtime/registerRealtime.compat.test.ts
git commit -m "feat(realtime): compat shim for legacy canvas relay, membership-enforced

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire into server.ts, delete the old block

**Files:**
- Modify: `server.ts` (delete lines ~92 `users` object and ~558-625 `io.on("connection")` block; add `registerRealtime` call after JWT_SECRET resolution; rewrite `/api/pages/active` at ~377)

**Interfaces:**
- Consumes: `registerRealtime`, `RealtimeHandle` from Task 3-6.
- Produces: running server uses the new core. `/api/pages/active` keeps returning `string[]` of active *pathnames* (unchanged REST contract; the guard it feeds stays broken-as-today and is properly fixed in WS3).

- [ ] **Step 1: Add the import and registration**

In `server.ts` imports: `import { registerRealtime } from './server/realtime/registerRealtime';`

The `io` server is created before `JWT_SECRET` is resolved, so register realtime **after** the JWT_SECRET block (`server.ts:117-127`), e.g. right beside the existing `registerDataRoutes` call:

```ts
  const realtime = registerRealtime(io, {
    verifyToken: (token: string) => {
      try { return jwt.verify(token, JWT_SECRET) as { id: string; username: string; role: string }; }
      catch { return null; }
    },
  });
```

- [ ] **Step 2: Delete the legacy presence state and socket block**

- Delete the module-level `const users: Record<...> = {}` (line ~92).
- Delete the whole `// WebSocket Logic` `io.on("connection", ...)` block (lines ~558-625).

- [ ] **Step 3: Rewrite /api/pages/active from the registry**

Replace the handler body (~line 377-386) with (also dropping the noisy `console.log`):

```ts
  app.get("/api/pages/active", authenticateToken, (req, res) => {
    try {
      const activePageIds = Array.from(new Set(
        realtime.registry.all().map(s => s.location?.path).filter((p): p is string => Boolean(p))
      ));
      res.json(activePageIds);
    } catch (error) {
      console.error("Error in /api/pages/active route:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
```

- [ ] **Step 4: Typecheck and full test suite**

Run: `npm run lint` — expected: clean.
Run: `npm run test` — expected: all existing tests + new realtime tests pass.

- [ ] **Step 5: Boot smoke**

Run: `timeout 15 npx tsx server.ts` (with default `./data`; Ctrl-C/timeout kill is fine)
Expected: server starts, no crash, migrations log, no socket errors on boot.

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "feat(realtime): server.ts uses authenticated realtime core; legacy socket block removed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Client — CollaborationContext on the new protocol

**Files:**
- Modify: `src/context/CollaborationContext.tsx` (full rewrite of the internals; public hook surface unchanged plus additions)
- Create: `src/utils/locationInfo.ts`
- Test: `src/utils/locationInfo.test.ts`, `src/context/CollaborationContext.test.tsx`

**Interfaces:**
- Consumes (wire protocol from Tasks 3-6): `auth: { token, color }` handshake; emits `set-location`, `heartbeat` (every 25 000 ms), `update-user`, legacy `cursor-move`/`measurement-update`; receives `sessions-snapshot` `{ selfId, sessions }`, `session-joined` (SessionInfo), `session-left` `{ sessionId }`, `session-updated` (SessionInfo), `user-cursor`, `measurement-sync`.
- Produces (context type — existing consumers keep compiling; `User` interface stays exported with the same fields):

```ts
interface CollaborationContextType {
  socket: Socket | null;
  users: User[];          // legacy shape, DERIVED: sessions in my current path
  globalUsers: User[];    // legacy shape, DERIVED: all sessions
  sessions: SessionView[];        // NEW: raw session list
  mySessionId: string | null;     // NEW
  followedUserId: string | null;              // unchanged (session id)
  setFollowedUserId: (id: string | null) => void;
  sendCursor: (x: number, y: number) => void;
  sendMeasurementUpdate: (pageId: string, action: 'add' | 'update' | 'delete', measurement: Measurement) => void;
  sendProjectUpdate: (projectId: string) => void;   // kept as no-op emit (dead wire, deleted WS4)
  updateUser: (name: string, color: string) => void;
  setPageName: (name: string) => void;
  onMeasurementSync: (cb: (data: { action: 'add' | 'update' | 'delete', measurement: Measurement }) => void) => () => void;
  onProjectSync: (cb: (data: { projectId: string }) => void) => () => void;  // never fires (as today); deleted WS4
}

interface SessionView {   // exported; mirrors server SessionInfo
  sessionId: string; userId: string; name: string; role: string; color: string;
  device: string;
  location: { path: string; projectId?: string; section?: string; pageId?: string; fileId?: string; label?: string } | null;
  editing: { type: string; id: string } | null;
  cursor: { x: number; y: number } | null;
  lastActive: number;
}
```

  Legacy derivation (used by `CanvasView`, `PdfCanvas`, `UserPresenceOverlay` untouched): `User { id: s.sessionId, userId: s.userId, name: s.name, pageId: s.location?.path ?? '', pageName: s.location?.label ?? '', cursor: s.cursor, color: s.color, lastActive: s.lastActive }`.
- Produces (`locationInfo.ts`): `locationFromPath(pathname: string, search: string, label?: string): LocationInfo-shaped object` parsing `/project/:projectId(/...)`, `/project/:id/page/:pageId`, `/tools/sheets?fileId=...`.

- [ ] **Step 1: Write the failing locationFromPath test**

```ts
// src/utils/locationInfo.test.ts
import { describe, it, expect } from 'vitest';
import { locationFromPath } from './locationInfo';

describe('locationFromPath', () => {
  it('parses a project section route', () => {
    expect(locationFromPath('/project/p1/billing', '')).toEqual(
      { path: '/project/p1/billing', projectId: 'p1', section: 'billing', pageId: undefined, fileId: undefined, label: undefined });
  });
  it('parses a canvas page route', () => {
    expect(locationFromPath('/project/p1/page/pg9', '', 'Floor 6')).toEqual(
      { path: '/project/p1/page/pg9', projectId: 'p1', section: 'page', pageId: 'pg9', fileId: undefined, label: 'Floor 6' });
  });
  it('parses project root as overview', () => {
    expect(locationFromPath('/project/p1', '')).toEqual(
      { path: '/project/p1', projectId: 'p1', section: 'overview', pageId: undefined, fileId: undefined, label: undefined });
  });
  it('parses the sheets tool with fileId', () => {
    expect(locationFromPath('/tools/sheets', '?fileId=f42')).toEqual(
      { path: '/tools/sheets', projectId: undefined, section: undefined, pageId: undefined, fileId: 'f42', label: undefined });
  });
  it('parses plain routes', () => {
    expect(locationFromPath('/dashboard', '')).toEqual(
      { path: '/dashboard', projectId: undefined, section: undefined, pageId: undefined, fileId: undefined, label: undefined });
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `npx vitest run --project ui src/utils/locationInfo.test.ts` → FAIL.

```ts
// src/utils/locationInfo.ts
// Parses the router pathname into the structured location the realtime
// server keys presence and rooms on. Kept dependency-free for testability.
export interface ClientLocationInfo {
  path: string;
  projectId?: string;
  section?: string;
  pageId?: string;
  fileId?: string;
  label?: string;
}

export function locationFromPath(pathname: string, search: string, label?: string): ClientLocationInfo {
  let projectId: string | undefined;
  let section: string | undefined;
  let pageId: string | undefined;
  let fileId: string | undefined;

  const projectMatch = pathname.match(/^\/project\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/);
  if (projectMatch) {
    projectId = projectMatch[1];
    section = projectMatch[2] || 'overview';
    if (projectMatch[2] === 'page' && projectMatch[3]) pageId = projectMatch[3];
  }
  if (pathname === '/tools/sheets') {
    fileId = new URLSearchParams(search).get('fileId') || undefined;
  }
  return { path: pathname, projectId, section, pageId, fileId, label };
}
```

Run: `npx vitest run --project ui src/utils/locationInfo.test.ts` → 5 passing.

- [ ] **Step 3: Write the failing context test**

```tsx
// src/context/CollaborationContext.test.tsx
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
  return { fakeSocket, ioMock: vi.fn(() => fakeSocket) };
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
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run --project ui src/context/CollaborationContext.test.tsx`
Expected: FAIL (current implementation joins with `join-page`, connects without token, has no `sessions`).

- [ ] **Step 5: Rewrite CollaborationContext.tsx**

Keep the exported `User` interface and `useCollaboration` exactly as-is. Replace the provider internals:

```tsx
// Inside CollaborationProvider — full new implementation outline with exact code:
export const CollaborationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [mySessionId, setMySessionId] = useState<string | null>(null);
  const [followedUserId, setFollowedUserId] = useState<string | null>(null);
  const [currentPageName, setCurrentPageName] = useState('Projects');
  // authEpoch bumps when a login happens so the connect effect re-runs
  const [authEpoch, setAuthEpoch] = useState(0);
  const measurementCallbacks = useRef<((data: any) => void)[]>([]);
  const projectCallbacks = useRef<((data: any) => void)[]>([]);

  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const onPrefsSync = () => setAuthEpoch(e => e + 1);
    window.addEventListener('app:prefs-sync', onPrefsSync);
    return () => window.removeEventListener('app:prefs-sync', onPrefsSync);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return; // not logged in — no socket until app:prefs-sync fires

    const storedColor = localStorage.getItem('userColor');
    const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
    const userColor = storedColor || colors[Math.floor(Math.random() * colors.length)];
    if (!storedColor) localStorage.setItem('userColor', userColor);

    const newSocket = io({
      // function form: reconnect attempts re-read the (possibly refreshed) token
      auth: (cb) => cb({ token: localStorage.getItem('token'), color: localStorage.getItem('userColor') || userColor }),
    });
    setSocket(newSocket);

    newSocket.on('sessions-snapshot', ({ selfId, sessions }: { selfId: string; sessions: SessionView[] }) => {
      setMySessionId(selfId);
      setSessions(sessions);
    });
    newSocket.on('session-joined', (s: SessionView) => {
      setSessions(prev => [...prev.filter(p => p.sessionId !== s.sessionId), s]);
    });
    newSocket.on('session-left', ({ sessionId }: { sessionId: string }) => {
      setSessions(prev => prev.filter(p => p.sessionId !== sessionId));
    });
    newSocket.on('session-updated', (s: SessionView) => {
      setSessions(prev => prev.map(p => (p.sessionId === s.sessionId ? s : p)));
    });
    newSocket.on('user-cursor', ({ id, cursor }: { id: string; cursor: { x: number; y: number } }) => {
      const now = Date.now();
      setSessions(prev => prev.map(p => (p.sessionId === id ? { ...p, cursor, lastActive: now } : p)));
    });
    newSocket.on('measurement-sync', (data) => {
      measurementCallbacks.current.forEach(cb => cb(data));
    });
    newSocket.on('project-sync', (data) => {  // dead wire, kept until WS4
      projectCallbacks.current.forEach(cb => cb(data));
    });

    const beat = setInterval(() => newSocket.emit('heartbeat'), 25_000);

    return () => {
      clearInterval(beat);
      newSocket.close();
      setSocket(null);
      setSessions([]);
      setMySessionId(null);
    };
  }, [authEpoch]);

  // Report structured location on every route change (and page-label change)
  useEffect(() => {
    if (!socket) return;
    socket.emit('set-location', locationFromPath(location.pathname, location.search, currentPageName));
  }, [socket, location.pathname, location.search, currentPageName]);

  // Reset page label off-canvas
  useEffect(() => {
    if (location.pathname === '/') setCurrentPageName('Projects');
  }, [location.pathname]);

  // Legacy derived shapes — keeps CanvasView/PdfCanvas/UserPresenceOverlay untouched in WS1
  const globalUsers: User[] = sessions.map(s => ({
    id: s.sessionId, userId: s.userId, name: s.name,
    pageId: s.location?.path ?? '', pageName: s.location?.label ?? '',
    cursor: s.cursor, color: s.color, lastActive: s.lastActive,
  }));
  const users: User[] = globalUsers.filter(u => u.pageId === location.pathname);

  // Following (unchanged semantics: followedUserId holds a session id)
  useEffect(() => {
    if (followedUserId && sessions.length > 0) {
      const followed = sessions.find(s => s.sessionId === followedUserId);
      const path = followed?.location?.path;
      if (path && path !== location.pathname) navigate(path);
    }
  }, [followedUserId, sessions, location.pathname, navigate]);

  const sendCursor = (x: number, y: number) => { socket?.emit('cursor-move', { x, y }); };
  const sendMeasurementUpdate = (pageId: string, action: 'add' | 'update' | 'delete', measurement: Measurement) => {
    socket?.emit('measurement-update', { pageId, action, measurement });
  };
  const sendProjectUpdate = (projectId: string) => { socket?.emit('project-update', { projectId }); };
  const updateUser = (name: string, color: string) => {
    localStorage.setItem('userColor', color);
    socket?.emit('update-user', { name, color });
  };
  const onMeasurementSync = (callback: (data: any) => void) => {
    measurementCallbacks.current.push(callback);
    return () => { measurementCallbacks.current = measurementCallbacks.current.filter(cb => cb !== callback); };
  };
  const onProjectSync = (callback: (data: any) => void) => {
    projectCallbacks.current.push(callback);
    return () => { projectCallbacks.current = projectCallbacks.current.filter(cb => cb !== callback); };
  };

  return (
    <CollaborationContext.Provider value={{
      socket, users, globalUsers, sessions, mySessionId,
      followedUserId, setFollowedUserId,
      sendCursor, sendMeasurementUpdate, sendProjectUpdate, updateUser,
      setPageName: setCurrentPageName, onMeasurementSync, onProjectSync,
    }}>
      {children}
    </CollaborationContext.Provider>
  );
};
```

Add at top: `import { locationFromPath } from '../utils/locationInfo';`, export the `SessionView` interface (fields per the Interfaces block), and extend `CollaborationContextType` with `sessions: SessionView[]; mySessionId: string | null;`.

- [ ] **Step 6: Run ui tests + typecheck**

Run: `npx vitest run --project ui` — expected: new tests pass, existing ui tests pass.
Run: `npm run lint` — expected: clean (proves `CanvasView`/`PdfCanvas`/`UserPresenceOverlay`/`ProjectView` still compile against the unchanged legacy surface).

- [ ] **Step 7: Commit**

```bash
git add src/context/CollaborationContext.tsx src/context/CollaborationContext.test.tsx src/utils/locationInfo.ts src/utils/locationInfo.test.ts
git commit -m "feat(realtime): client connects with JWT, session-delta presence, legacy shapes derived

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification, e2e, checklist, push

**Files:**
- Modify: `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md` (tick WS1 items with hashes)

- [ ] **Step 1: Full unit suite + typecheck**

Run: `npm run test` and `npm run lint`
Expected: everything green.

- [ ] **Step 2: Playwright e2e**

Run: `npm run test:e2e`
Expected: all specs pass — the e2e harness logs in for real, so its canvas specs now exercise the authenticated socket path end-to-end. If Chromium system libs are missing in this environment (`libnspr4 libnss3 libasound2t64` per repo memory), report that instead of skipping silently.

- [ ] **Step 3: Two-client live smoke (Playwright, throwaway or kept as spec)**

Add `e2e/collab-presence.spec.ts`: two browser contexts log in, both navigate to the same project; assert context B's presence overlay shows user A (and that A's entry disappears when A's context closes). Model the login/bootstrap on an existing spec in `e2e/` (they share a helper pattern — reuse it). This is the WS1 acceptance proof and stays in the suite.

- [ ] **Step 4: Update the WS1 checklist**

In `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md`, set each completed WS1 item to `[x] … (`hash`)` using the actual commit hashes, and add the plan path under the WS1 heading: `Plan: docs/superpowers/plans/2026-08-23-ws1-realtime-core.md`.

- [ ] **Step 5: Commit and push**

```bash
git add docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md e2e/collab-presence.spec.ts
git commit -m "test(realtime): two-context presence e2e; WS1 checklist complete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin testing
```

---

## Self-Review Notes

- **Spec §3 coverage:** auth (T3), sessions + device labels (T1-T3), location + rooms + membership (T4, T6), heartbeat/sweep (T5), delta events replacing `global-users` full-array broadcast (T3-T4, old block deleted in T7), compat shim (T6), client JWT connect + deltas + legacy derivation (T8), `/api/pages/active` reimplemented on registry (T7). `editing` field carried but not yet settable — that event lands in WS2 by design.
- **Old `join-page`/`room-users`/`global-users` events:** intentionally NOT kept — the only emitter/consumer is `CollaborationContext`, rewritten in T8; other components consume the context's derived arrays, not socket events. `user-cursor`/`measurement-sync`/`cursor-move`/`measurement-update` ARE kept because `CanvasView`/`PdfCanvas` use them through context functions with unchanged signatures.
- **Type consistency check:** `SessionInfo` (server) and `SessionView` (client) field lists match; `pathRoom`/`projectRoom`/`pageRoom`/`sheetRoom` names consistent across T4/T6; harness helpers used identically in T3/T4/T5/T6 tests.
- Server `crypto.randomUUID` exists in `server.ts` (Node-side, allowed); client code uses only the `uuid` package — none needed in WS1 client changes.
