# WS2 — Change Feed + Live Refresh + Edit Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every screen updates in real time when anyone saves anything; editors show who else is editing the same entity (warn-but-allow) and refresh live; the destructive 409 full-page reload becomes an in-place refresh.

**Architecture:** A `broadcastChange()` function (created from the WS1 socket server, injected into the route layer like `verifyToken`) emits a tiny `entity-changed` event — identity + version only, no payload — after each successful mutation. A client `useLiveQuery(load, filter)` hook wraps each screen's existing `load()`: refetch on matching events, with self-echo suppression via a stable per-tab `X-Session-Id`, 300ms debounce, version dedupe, and reconnect catch-up. Edit awareness rides the WS1 session registry: editors declare `set-editing` presence, a shared banner shows other editors, and incoming changes silently remount a pristine form or offer Review-merge / Keep-mine on a dirty one.

**Tech Stack:** socket.io 4.8 (WS1 `server/realtime/`), Express route DI (`RouteDeps`), React 19 hooks, uuid (client tab id), Vitest (server: supertest + WS1 `testHarness.ts`; ui: RTL partial-mock of store.ts), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-realtime-collaboration-design.md` (§4 = WS2). Progress: `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md` — tick WS2 items with commit hashes in the same commit as the work.

## Global Constraints

- **No secure-context browser APIs** in `src/**` (plain-HTTP LAN) — use the `uuid` package (already imported in client files, e.g. `TaskEditor.tsx:2`).
- No schema/migration changes. SQLite `journal_mode = DELETE` untouched. Single-process.
- All existing tests keep passing (`npm run test`, 1029), `npm run lint` clean, e2e (`npm run test:e2e`, 48+) green at the end.
- Git: commit per task on `testing`; push only in the final task. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The `entity-changed` event carries **no entity payload** — identity + version only (permission safety: data always refetched over authed REST).
- Wire event name is `entity-changed`. Do NOT reuse the dead `project-sync` wire (it is deleted in WS4).
- **sessionId gotcha (WS1):** socket sessionIds equal `socket.id` and change on every reconnect. Self-echo suppression therefore uses a **stable per-tab client id** (`CLIENT_SESSION_ID`, uuid, module-level), NOT the socket sessionId. This supersedes the carried checklist wording "read the current socket id fresh" — the final task rewrites that checklist line to match.
- **Plan-level deviation from spec §4 (ruled by controller):** `entity-changed` is emitted **globally** (`io.emit`), not into `project:` rooms. Reason: the dashboard, projects list, and customers view render cross-project rollups (billing totals, task cards) and would miss room-scoped events for projects they aren't "in". Events are ~150 bytes, the deployment is a small LAN crew, and refetches remain permission-checked REST. Room-scoped emission remains a later optimization; `projectId` stays on the event for client-side filtering.

## File Structure

| File | Responsibility |
|---|---|
| Create `server/realtime/changeFeed.ts` | `EntityChangedEvent` type, `ENTITY_CHANGED` const, `createChangeFeed(io)` → `broadcastChange(ev)` (global emit), `requestMeta(req)` helper |
| Create `server/realtime/verifyPayload.ts` | `normalizeTokenPayload(raw)` — carried WS1 item: reject/normalize malformed JWT payloads |
| Modify `server/routes.ts` | `RouteDeps` gains `broadcastChange`; ~45 mutation sites call it |
| Modify `server.ts` | build the feed, pass into `registerDataRoutes`/`registerEmailRoutes`, call from inline routes (notes/users/time-entries/templates), normalize verifyToken |
| Modify `server/realtime/registerRealtime.ts` | new `set-editing` socket handler |
| Create `src/utils/clientSession.ts` | `CLIENT_SESSION_ID` (stable per-tab uuid) |
| Modify `src/utils/store.ts` | `getAuthHeaders()` adds `X-Session-Id`; `getProject` records `latestVersions` |
| Create `src/hooks/useLiveQuery.ts` | the live-refresh hook |
| Create `src/hooks/useCollabEditing.ts` | editing presence + live-entity state for editors |
| Create `src/components/EditPresenceBanner.tsx` | "X is editing" + "changed while editing" banner |
| Create `src/components/EditingChip.tsx` | list-row "being edited" chip |
| Modify section screens (12 files) | swap `useEffect(load)` → `useLiveQuery` |
| Modify editors (9 files) | wire `useCollabEditing` + banner + Keep-mine version override |
| Modify `src/components/ProjectConflictListener.tsx` | soft refresh instead of `window.location.reload()` |
| Modify `src/pages/ProjectView.tsx` | listen for `project-refreshed`, live-refresh on foreign project events |

---

### Task 1: Change feed module + verifyToken normalization + deps plumbing

**Files:**
- Create: `server/realtime/changeFeed.ts`
- Create: `server/realtime/verifyPayload.ts`
- Test: `server/realtime/changeFeed.test.ts`, `server/realtime/verifyPayload.test.ts`
- Modify: `server/routes.ts:58-67` (RouteDeps), `server.ts` (~121-168: verifyToken closure + feed creation + deps)

**Interfaces:**
- Produces (`changeFeed.ts` — every later task imports these exact names):

```ts
export type EntityType =
  | 'project' | 'task' | 'issue' | 'rfi' | 'punch'
  | 'invoice' | 'changeOrder' | 'payment' | 'aiaSov' | 'aiaPayApp'
  | 'file' | 'note' | 'customer' | 'user' | 'timeEntry' | 'template';

export interface EntityChangedEvent {
  type: EntityType;
  id: string;
  projectId?: string;
  version?: number;
  action: 'created' | 'updated' | 'deleted';
  byUserId?: string;
  bySessionId?: string;
}

export const ENTITY_CHANGED = 'entity-changed';

export type BroadcastChange = (ev: EntityChangedEvent) => void;

export function createChangeFeed(io: Server): BroadcastChange;

// Pulls byUserId (from authenticateToken's req.user) and bySessionId
// (from the client's X-Session-Id header) off an express request.
export function requestMeta(req: { user?: { id?: string }; get(name: string): string | undefined }):
  { byUserId?: string; bySessionId?: string };
```

- Produces (`verifyPayload.ts`): `normalizeTokenPayload(raw: unknown): { id: string; username: string; role: string } | null` — returns null unless all three fields are non-empty strings.
- Produces (routes.ts): `RouteDeps` gains `broadcastChange: BroadcastChange`. server.ts holds `const broadcastChange = createChangeFeed(io)` and passes it to both `registerDataRoutes` and `registerEmailRoutes` deps (registerEmailRoutes shares the same deps object per routes.ts:1283 signature — verify and extend the same way).

- [ ] **Step 1: Write the failing tests**

```ts
// server/realtime/verifyPayload.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeTokenPayload } from './verifyPayload';

describe('normalizeTokenPayload', () => {
  it('passes a valid payload through', () => {
    expect(normalizeTokenPayload({ id: 'u1', username: 'nathan', role: 'admin', iat: 1, exp: 2 }))
      .toEqual({ id: 'u1', username: 'nathan', role: 'admin' });
  });
  it('rejects missing role (legacy token)', () => {
    expect(normalizeTokenPayload({ id: 'u1', username: 'nathan' })).toBeNull();
  });
  it('rejects non-string id and empty strings', () => {
    expect(normalizeTokenPayload({ id: 5, username: 'n', role: 'admin' })).toBeNull();
    expect(normalizeTokenPayload({ id: '', username: 'n', role: 'admin' })).toBeNull();
  });
  it('rejects null/undefined/non-object', () => {
    expect(normalizeTokenPayload(null)).toBeNull();
    expect(normalizeTokenPayload('str')).toBeNull();
  });
});
```

```ts
// server/realtime/changeFeed.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './testHarness';
import { createChangeFeed, requestMeta, ENTITY_CHANGED, type EntityChangedEvent } from './changeFeed';

describe('createChangeFeed', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  beforeEach(async () => { srv = await startRealtimeServer(); });
  afterEach(async () => { await srv.close(); });

  it('broadcasts entity-changed globally to connected clients', async () => {
    const client = connectClient(srv.port, makeToken());
    await waitFor(client, 'sessions-snapshot');
    const broadcast = createChangeFeed(srv.io);
    const evt = waitFor<EntityChangedEvent>(client, ENTITY_CHANGED);
    broadcast({ type: 'issue', id: 'i1', projectId: 'p1', version: 3, action: 'updated', byUserId: 'u1', bySessionId: 'tab-1' });
    expect(await evt).toEqual({ type: 'issue', id: 'i1', projectId: 'p1', version: 3, action: 'updated', byUserId: 'u1', bySessionId: 'tab-1' });
    client.close();
  });

  it('reaches clients regardless of which project room they are in', async () => {
    const client = connectClient(srv.port, makeToken());
    await waitFor(client, 'sessions-snapshot');
    client.emit('set-location', { path: '/project/OTHER/billing', projectId: 'OTHER' });
    await new Promise(r => setTimeout(r, 100));
    const broadcast = createChangeFeed(srv.io);
    const evt = waitFor<EntityChangedEvent>(client, ENTITY_CHANGED);
    broadcast({ type: 'task', id: 't1', projectId: 'p1', action: 'created' });
    expect((await evt).id).toBe('t1');
    client.close();
  });
});

describe('requestMeta', () => {
  it('extracts user id and session header', () => {
    const req = { user: { id: 'u1' }, get: (n: string) => (n.toLowerCase() === 'x-session-id' ? 'tab-9' : undefined) };
    expect(requestMeta(req)).toEqual({ byUserId: 'u1', bySessionId: 'tab-9' });
  });
  it('tolerates missing user and header', () => {
    const req = { get: () => undefined };
    expect(requestMeta(req)).toEqual({ byUserId: undefined, bySessionId: undefined });
  });
});
```

- [ ] **Step 2: Run to verify both fail** — `npx vitest run --project server server/realtime/verifyPayload.test.ts server/realtime/changeFeed.test.ts` → module-not-found.

- [ ] **Step 3: Implement**

```ts
// server/realtime/verifyPayload.ts
// Boundary normalization for JWT payloads (carried WS1 finding): a legacy or
// malformed token must yield null — never identity fields like the string
// "undefined". WS2+ gates behavior on role, so this is load-bearing.
export function normalizeTokenPayload(raw: unknown): { id: string; username: string; role: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id) return null;
  if (typeof p.username !== 'string' || !p.username) return null;
  if (typeof p.role !== 'string' || !p.role) return null;
  return { id: p.id, username: p.username, role: p.role };
}
```

```ts
// server/realtime/changeFeed.ts
// The app-wide change feed: after a successful REST mutation, the route layer
// calls broadcastChange with identity + version ONLY (never entity data —
// clients refetch over authed REST). Emitted globally rather than into
// project rooms: dashboards and list views render cross-project rollups and
// would miss room-scoped events (ruled deviation from spec §4, see plan).
import type { Server } from 'socket.io';

export type EntityType =
  | 'project' | 'task' | 'issue' | 'rfi' | 'punch'
  | 'invoice' | 'changeOrder' | 'payment' | 'aiaSov' | 'aiaPayApp'
  | 'file' | 'note' | 'customer' | 'user' | 'timeEntry' | 'template';

export interface EntityChangedEvent {
  type: EntityType;
  id: string;
  projectId?: string;
  version?: number;
  action: 'created' | 'updated' | 'deleted';
  byUserId?: string;
  bySessionId?: string;
}

export const ENTITY_CHANGED = 'entity-changed';

export type BroadcastChange = (ev: EntityChangedEvent) => void;

export function createChangeFeed(io: Server): BroadcastChange {
  return (ev: EntityChangedEvent) => {
    io.emit(ENTITY_CHANGED, ev);
  };
}

export function requestMeta(req: { user?: { id?: string }; get(name: string): string | undefined }):
  { byUserId?: string; bySessionId?: string } {
  return {
    byUserId: typeof req.user?.id === 'string' ? req.user.id : undefined,
    bySessionId: req.get('x-session-id') || undefined,
  };
}
```

Then wire the plumbing (no call sites yet):
- `server/routes.ts`: import `type { BroadcastChange }` from `./realtime/changeFeed`; add `broadcastChange: BroadcastChange;` to `RouteDeps` (routes.ts:58-67).
- `server.ts`: import `createChangeFeed` and `normalizeTokenPayload`. After `registerRealtime(...)`, add `const broadcastChange = createChangeFeed(io);`. Change the verifyToken closure (both the one passed to `registerRealtime` at server.ts:~121-127 and the one in `registerDataRoutes` deps at server.ts:165-167) to `try { return normalizeTokenPayload(jwt.verify(token, JWT_SECRET)); } catch { return null; }`. Add `broadcastChange` to the `registerDataRoutes` deps object (and `registerEmailRoutes` if it takes its own deps — check routes.ts:1283 signature and extend the same way).
- `server/routes.test.ts` constructs deps directly — add `broadcastChange: () => {}` to its deps object(s) so it compiles (grep for `registerDataRoutes(app` in the test file).

- [ ] **Step 4: Run** — the two new test files pass; then `npx vitest run --project server` (all pass) and `npm run lint` (clean).

- [ ] **Step 5: Commit**

```bash
git add server/realtime/changeFeed.ts server/realtime/changeFeed.test.ts server/realtime/verifyPayload.ts server/realtime/verifyPayload.test.ts server/routes.ts server.ts server/routes.test.ts
git commit -m "feat(realtime): entity change feed + JWT payload normalization, DI plumbing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Broadcast from project-scoped mutation routes

**Files:**
- Modify: `server/routes.ts` (sites listed below)
- Test: `server/routes.changefeed.test.ts` (new)

**Interfaces:**
- Consumes: `deps.broadcastChange`, `requestMeta` (import from `./realtime/changeFeed`).
- Produces: every listed route emits exactly one `entity-changed` after its successful store call (before `res.json`). Photo add/remove routes emit as `action: 'updated'` on the parent entity.

**The pattern** (apply uniformly — this example is `PUT /api/issues/:id`, routes.ts:422):

```ts
app.put('/api/issues/:id', authenticateToken, (req: any, res) => {
  try {
    const result = saveIssue(db, req.params.id, req.body);   // existing call, untouched
    const row = getIssue(db, req.params.id);                  // cheap single-row read for projectId (+fresh version)
    if (row) deps.broadcastChange({
      type: 'issue', id: req.params.id, projectId: row.projectId,
      version: row.version, action: 'updated', ...requestMeta(req),
    });
    res.json({ success: true, ...result });                   // existing response, untouched
  } catch (e) { /* existing error handling untouched */ }
});
```

Rules:
- `action`: POST create → `'created'`; PUT/PATCH/photo-routes/sends → `'updated'`; DELETE → `'deleted'`.
- `projectId`: use `req.params.id` on `/api/projects/:id/...` nested routes; otherwise load the row (`getIssue`/`getRfi`/`getPunchItem`/`getInvoice`/`getChangeOrder` etc. — all exist as cheap reads). **For DELETE by entity id, load the row BEFORE the delete** to capture projectId.
- `version`: include when the store result or the loaded row carries one; omit otherwise. Never invent one.
- Broadcast only on the success path, after the store call, before `res.json`. Never inside a catch.
- `broadcastChange` must never be able to fail the request: it only does `io.emit` (fire-and-forget) — no try/catch needed at call sites.

**Sites** (entity → routes, with the projectId source):

| Entity type | Routes (routes.ts lines) | projectId source |
|---|---|---|
| `project` | POST /api/projects :118 (created), PUT :133 (updated, version from result), PATCH :145 (updated), DELETE :164 (deleted) | `req.params.id` / new id; projectId = the project's own id |
| `invoice` | POST :226, PUT :236, PATCH :239, DELETE :246 (load before), send :1365 (updated, load via getInvoice already present) | nested param / loaded row |
| `payment` | POST :253, DELETE :260 (load before via getPayment or the store's row read — if no single-get exists, query the row by id inline) | nested param / loaded row |
| `changeOrder` | POST :267, PATCH :274, PUT :285, DELETE :288 (load before), photos POST :291 + DELETE :298 (updated), send :1390 (updated) | nested param / loaded row |
| `aiaSov` | POST/PUT/DELETE sov :319-325, seed :328, sync-change-orders :331 | nested `req.params.id`; for /api/aia/sov/:lineId load line row |
| `aiaPayApp` | POST :339, PUT lines :367, PATCH :370, DELETE :373 (load before) | nested param / loaded row |
| `issue` | POST :412, PUT :422, PATCH :425 (before-load exists), DELETE :436 (load before), photos :439/:446, send :1439 | nested param / loaded row |
| `rfi` | POST :463, PUT :473, PATCH :476, DELETE :487 (load before), photos :490/:497, response :501, send :1464 | nested param / loaded row |
| `punch` | POST :524, PUT :534, PATCH :537, DELETE :548 (load before), photos :551/:558, send (send-punch) :1418 (project-level: emit type 'punch' with projectId=param, id='*' is NOT allowed — emit type `'project'`? No: punch send doesn't mutate punch rows; SKIP broadcast on send-punch) | nested param / loaded row |
| `project` (proposal send) | send-proposal :1325 also saves the project → emit type `'project'`, action 'updated', projectId = param | param |

(Line numbers drift as edits land — locate each route by its method+path, not the number.)

- [ ] **Step 1: Write the failing integration test**

The test builds a real express app + real socket server sharing one `io`, following `server/routes.test.ts`'s beforeEach pattern (in-memory db + real migrations + stub auth) and `server/realtime/testHarness.ts`:

```ts
// server/routes.changefeed.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { registerDataRoutes } from './routes';
import { createChangeFeed, ENTITY_CHANGED, type EntityChangedEvent } from './realtime/changeFeed';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './realtime/testHarness';

describe('route mutations broadcast entity-changed', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  let app: express.Express;
  let db: ReturnType<typeof openDb>;
  let dataDir: string;

  beforeEach(async () => {
    srv = await startRealtimeServer();
    db = openDb(':memory:');
    dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cf-test-'));
    runMigrations(db, dataDir, migrations, { dbFile: ':memory:', vacuum: false });
    app = express();
    app.use(express.json());
    registerDataRoutes(app, {
      db, dataDir, dbFile: ':memory:',
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 'test', role: 'admin' }; next(); },
      requireAdmin: (_req: any, _res: any, next: any) => next(),
      verifyToken: () => ({ id: 'u1', username: 'test', role: 'admin' }),
      broadcastChange: createChangeFeed(srv.io),
    });
  });
  afterEach(async () => { await srv.close(); db.close(); fsSync.rmSync(dataDir, { recursive: true, force: true }); });

  async function connectedClient() {
    const c = connectClient(srv.port, makeToken());
    await waitFor(c, 'sessions-snapshot');
    return c;
  }

  it('POST /api/projects/:id/issues broadcasts issue created with projectId and session meta', async () => {
    // seed a project
    await request(app).post('/api/projects').send({ id: 'p1', name: 'P1', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/projects/p1/issues')
      .set('X-Session-Id', 'tab-A').send({ title: 'crack' }).expect(200);
    const e = await evt;
    expect(e.type).toBe('issue');
    expect(e.id).toBe(res.body.id);
    expect(e.projectId).toBe('p1');
    expect(e.action).toBe('created');
    expect(e.bySessionId).toBe('tab-A');
    expect(e.byUserId).toBe('u1');
    c.close();
  });

  it('DELETE /api/issues/:id captures projectId BEFORE deleting', async () => {
    await request(app).post('/api/projects').send({ id: 'p1', name: 'P1', pages: [], takeoffs: [] }).expect(200);
    const created = await request(app).post('/api/projects/p1/issues').send({ title: 'x' }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).delete(`/api/issues/${created.body.id}`).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'issue', id: created.body.id, projectId: 'p1', action: 'deleted' });
    c.close();
  });

  it('PUT /api/projects/:id broadcasts project updated with the new version', async () => {
    await request(app).post('/api/projects').send({ id: 'p2', name: 'P2', pages: [], takeoffs: [] }).expect(200);
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    await request(app).put('/api/projects/p2').send({ id: 'p2', name: 'P2 renamed', pages: [], takeoffs: [], version: 1 }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'project', id: 'p2', action: 'updated' });
    expect(typeof e.version).toBe('number');
    c.close();
  });
});
```

Adjust seed bodies to whatever `POST /api/projects` actually requires (read the route + `createProject` in projectStore.ts first; routes.test.ts has working seed examples — copy its project fixture).

- [ ] **Step 2: Run to verify it fails** (no broadcasts wired yet — `waitFor` promises time out): `npx vitest run --project server server/routes.changefeed.test.ts` → FAIL.

- [ ] **Step 3: Wire every site in the table above** with the pattern. Use `deps.broadcastChange` and `requestMeta(req)` consistently. Where a `before` row is already loaded (issue PATCH etc.) reuse it instead of a second read.

- [ ] **Step 4: Run** — new test passes; full `npx vitest run --project server` passes (existing routes.test.ts unaffected: its stub `broadcastChange: () => {}` swallows events).

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.changefeed.test.ts
git commit -m "feat(realtime): project-scoped mutation routes broadcast entity-changed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Broadcast from remaining mutations (tasks, files, customers, inline server.ts routes)

**Files:**
- Modify: `server/routes.ts` (tasks :577-616, files :645-859, customers :1152-1180), `server.ts` (notes :370, users :246/:274/:302, templates :332/:344, time-entries :605-696)
- Test: extend `server/routes.changefeed.test.ts`

**Interfaces:** Consumes Task 1-2's pattern verbatim. Type mapping: tasks → `'task'` (projectId from the post-mutation row — `req.body.projectId` on create, loaded row otherwise; omit when null), files → `'file'` (projectId from the row where `patchDocument`/`deleteDocument` return it; omit otherwise), customers → `'customer'` (no projectId; on `PUT /api/customers/:id` ALSO emit a second event `{type:'project', id: '*'}`? NO — keep one event per mutation: the customer rename side-effect on projects is covered because customer-list screens subscribe to `'customer'` and project screens' data doesn't render stale names critically; YAGNI), notes → `'note'` with projectId = `req.params.projectId`, users → `'user'`, templates → `'template'`, time-entries → `'timeEntry'` (no projectId filter needed — TimeKeeping subscribes unscoped).

server.ts inline routes call the module-level `broadcastChange` const directly (it's in scope inside `startServer()`); they have `req.user` via `authenticateToken`, so `requestMeta(req)` works unchanged.

- [ ] **Step 1: Extend the failing test** — add to `server/routes.changefeed.test.ts`:

```ts
  it('POST /api/tasks broadcasts task created (projectId omitted when unscoped)', async () => {
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/tasks').set('X-Session-Id', 'tab-B').send({ title: 'call supplier' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'task', id: res.body.id, action: 'created', bySessionId: 'tab-B' });
    expect(e.projectId).toBeUndefined();
    c.close();
  });

  it('POST /api/customers broadcasts customer created', async () => {
    const c = await connectedClient();
    const evt = waitFor<EntityChangedEvent>(c, ENTITY_CHANGED);
    const res = await request(app).post('/api/customers').send({ name: 'Acme' }).expect(200);
    const e = await evt;
    expect(e).toMatchObject({ type: 'customer', action: 'created' });
    c.close();
  });
```

(Task body/response shapes: read the tasks routes first — `POST /api/tasks` at routes.ts:589 — and match what they return. The inline server.ts routes are NOT under supertest here — they get no new test file; their wiring is identical one-liners and the e2e in Task 11 exercises the notes path.)

- [ ] **Step 2: Run to verify the new cases fail.**
- [ ] **Step 3: Wire all sites** (routes.ts tables + server.ts inline). Skip: drafts (per-user), shares (public-link plumbing), settings/user-preferences (not list-rendered), storage cleanup (maintenance), auth/change-password.
- [ ] **Step 4: Run** — full server project green, `npm run lint` clean.
- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.changefeed.test.ts server.ts
git commit -m "feat(realtime): remaining mutations broadcast entity-changed (tasks, files, customers, inline routes)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Client foundation — CLIENT_SESSION_ID, X-Session-Id header, useLiveQuery

**Files:**
- Create: `src/utils/clientSession.ts`
- Create: `src/hooks/useLiveQuery.ts`
- Modify: `src/utils/store.ts:6-9` (`getAuthHeaders`)
- Test: `src/hooks/useLiveQuery.test.tsx`

**Interfaces:**
- Produces (`clientSession.ts`):

```ts
import { v4 as uuidv4 } from 'uuid';
// Stable per-tab id for self-echo suppression on the change feed. Deliberately
// NOT the socket sessionId (= socket.id): that changes on every reconnect and
// doesn't exist before the socket connects, while REST calls fire immediately.
export const CLIENT_SESSION_ID = uuidv4();
```

- Produces (`useLiveQuery.ts`):

```ts
export type EntityType =
  | 'project' | 'task' | 'issue' | 'rfi' | 'punch'
  | 'invoice' | 'changeOrder' | 'payment' | 'aiaSov' | 'aiaPayApp'
  | 'file' | 'note' | 'customer' | 'user' | 'timeEntry' | 'template';

export interface EntityChangedEvent {
  type: EntityType; id: string; projectId?: string; version?: number;
  action: 'created' | 'updated' | 'deleted'; byUserId?: string; bySessionId?: string;
}

export interface LiveFilter {
  types: EntityType[];
  projectId?: string;   // match events with this projectId OR no projectId
  id?: string;          // match only this entity id
}

export function useLiveQuery(load: () => void | Promise<void>, filter: LiveFilter, opts?: { debounceMs?: number }): void;
```

Behavior contract (each is a test):
1. Runs `load()` once on mount and again when the filter's JSON key changes.
2. On a matching `entity-changed` socket event, re-runs `load()` after `debounceMs` (default 300), coalescing bursts into one call.
3. Skips events whose `bySessionId === CLIENT_SESSION_ID` (self-echo).
4. Skips events whose type isn't in `types`; skips when `filter.projectId` and `event.projectId` are both set and differ; skips when `filter.id` is set and differs.
5. Version dedupe: per `type:id`, if `event.version` is ≤ the highest already seen, skip.
6. On socket `connect` (reconnect), re-runs `load()` once (no debounce).
7. Uses a ref for `load` (no resubscribe churn when callers pass inline closures); unsubscribes on unmount.

- Modify `getAuthHeaders()` (store.ts:6-9):

```ts
import { CLIENT_SESSION_ID } from './clientSession';
export const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return {
    'X-Session-Id': CLIENT_SESSION_ID,
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
};
```

(Callers spread the result into headers objects — adding a key is transparent. Check `getAuthHeaders`'s TS usage: some call sites type it as `Record<string,string>` implicitly; run lint.)

- [ ] **Step 1: Write the failing hook test**

```tsx
// src/hooks/useLiveQuery.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { CLIENT_SESSION_ID } from '../utils/clientSession';

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
vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));

import { useLiveQuery, type LiveFilter } from './useLiveQuery';

function Harness({ load, filter }: { load: () => void; filter: LiveFilter }) {
  useLiveQuery(load, filter, { debounceMs: 50 });
  return null;
}

const evt = (over: Record<string, unknown> = {}) => ({
  type: 'issue', id: 'i1', projectId: 'p1', action: 'updated', bySessionId: 'other-tab', ...over,
});

describe('useLiveQuery', () => {
  beforeEach(() => { vi.useFakeTimers(); for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k]; });
  afterEach(() => vi.useRealTimers());

  it('loads on mount and refetches (debounced) on a matching event', async () => {
    const load = vi.fn();
    render(<Harness load={load} filter={{ types: ['issue'], projectId: 'p1' }} />);
    expect(load).toHaveBeenCalledTimes(1);
    act(() => { fakeSocket.fire('entity-changed', evt()); fakeSocket.fire('entity-changed', evt({ id: 'i2' })); });
    expect(load).toHaveBeenCalledTimes(1);          // debounced, not yet
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(load).toHaveBeenCalledTimes(2);          // burst coalesced to one
  });

  it('skips self-echo, foreign types, and foreign projects', async () => {
    const load = vi.fn();
    render(<Harness load={load} filter={{ types: ['issue'], projectId: 'p1' }} />);
    act(() => {
      fakeSocket.fire('entity-changed', evt({ bySessionId: CLIENT_SESSION_ID }));
      fakeSocket.fire('entity-changed', evt({ type: 'task' }));
      fakeSocket.fire('entity-changed', evt({ projectId: 'p2' }));
    });
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(load).toHaveBeenCalledTimes(1);          // only the mount load
  });

  it('matches events without projectId even when filter has one (safe over-refetch)', async () => {
    const load = vi.fn();
    render(<Harness load={load} filter={{ types: ['task'], projectId: 'p1' }} />);
    act(() => { fakeSocket.fire('entity-changed', evt({ type: 'task', projectId: undefined })); });
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('version dedupe skips stale/duplicate versions per entity', async () => {
    const load = vi.fn();
    render(<Harness load={load} filter={{ types: ['issue'] }} />);
    act(() => { fakeSocket.fire('entity-changed', evt({ version: 5 })); });
    await act(async () => { vi.advanceTimersByTime(60); });
    act(() => { fakeSocket.fire('entity-changed', evt({ version: 5 })); fakeSocket.fire('entity-changed', evt({ version: 4 })); });
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(load).toHaveBeenCalledTimes(2);          // mount + v5; v5-dup and v4 skipped
  });

  it('refetches once on socket reconnect', async () => {
    const load = vi.fn();
    render(<Harness load={load} filter={{ types: ['issue'] }} />);
    act(() => { fakeSocket.fire('connect'); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<Harness load={vi.fn()} filter={{ types: ['issue'] }} />);
    unmount();
    expect((fakeSocket.handlers['entity-changed'] ?? []).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run --project ui src/hooks/useLiveQuery.test.tsx`.

- [ ] **Step 3: Implement**

```ts
// src/hooks/useLiveQuery.ts
import { useEffect, useRef } from 'react';
import { useCollaboration } from '../context/CollaborationContext';
import { CLIENT_SESSION_ID } from '../utils/clientSession';

export type EntityType =
  | 'project' | 'task' | 'issue' | 'rfi' | 'punch'
  | 'invoice' | 'changeOrder' | 'payment' | 'aiaSov' | 'aiaPayApp'
  | 'file' | 'note' | 'customer' | 'user' | 'timeEntry' | 'template';

export interface EntityChangedEvent {
  type: EntityType; id: string; projectId?: string; version?: number;
  action: 'created' | 'updated' | 'deleted'; byUserId?: string; bySessionId?: string;
}

export interface LiveFilter { types: EntityType[]; projectId?: string; id?: string; }

export function useLiveQuery(
  load: () => void | Promise<void>,
  filter: LiveFilter,
  opts: { debounceMs?: number } = {},
): void {
  const { socket } = useCollaboration();
  const loadRef = useRef(load);
  loadRef.current = load;
  const filterKey = JSON.stringify([filter.types, filter.projectId ?? null, filter.id ?? null]);
  const debounceMs = opts.debounceMs ?? 300;

  // Initial load + reload when the filter identity changes.
  useEffect(() => { void loadRef.current(); }, [filterKey]);

  useEffect(() => {
    if (!socket) return;
    const f: LiveFilter = JSON.parse(filterKey).reduce(
      (acc: LiveFilter, v: unknown, i: number) =>
        i === 0 ? { ...acc, types: v as EntityType[] }
        : i === 1 ? { ...acc, projectId: (v as string | null) ?? undefined }
        : { ...acc, id: (v as string | null) ?? undefined },
      { types: [] });
    const seenVersions = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onEvent = (ev: EntityChangedEvent) => {
      if (ev.bySessionId === CLIENT_SESSION_ID) return;
      if (!f.types.includes(ev.type)) return;
      if (f.projectId && ev.projectId && ev.projectId !== f.projectId) return;
      if (f.id && ev.id !== f.id) return;
      if (typeof ev.version === 'number') {
        const key = `${ev.type}:${ev.id}`;
        const seen = seenVersions.get(key) ?? 0;
        if (ev.version <= seen) return;
        seenVersions.set(key, ev.version);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void loadRef.current(); }, debounceMs);
    };
    const onConnect = () => { void loadRef.current(); };

    socket.on('entity-changed', onEvent);
    socket.on('connect', onConnect);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off('entity-changed', onEvent);
      socket.off('connect', onConnect);
    };
  }, [socket, filterKey, debounceMs]);
}
```

Also create `src/utils/clientSession.ts` (code in Interfaces) and edit `getAuthHeaders()` (code above).

- [ ] **Step 4: Run** — hook tests pass; `npx vitest run --project ui` (all — existing tests using the real `getAuthHeaders` still pass since the extra header is inert); `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/utils/clientSession.ts src/hooks/useLiveQuery.ts src/hooks/useLiveQuery.test.tsx src/utils/store.ts
git commit -m "feat(realtime): client change-feed foundation — X-Session-Id header + useLiveQuery hook

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Convert core sections to live refresh (batch 1)

**Files:**
- Modify: `src/pages/project/ProjectIssues.tsx:28-32`, `src/pages/project/ProjectRfis.tsx:36-40`, `src/pages/project/ProjectPunch.tsx:76-80`, `src/pages/project/ProjectNotes.tsx:18`, `src/pages/TasksPage.tsx:31-50`
- Test: `src/pages/project/ProjectIssues.test.tsx` (new, representative)

**Interfaces:** Consumes `useLiveQuery` (Task 4). The mechanical conversion, worked example (ProjectIssues):

```tsx
// BEFORE (ProjectIssues.tsx:28-32)
const load = () => {
  if (!projectId) return;
  getIssues(projectId).then(setIssues).catch(() => setIssues([]));
};
useEffect(load, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

// AFTER
const load = () => {
  if (!projectId) return;
  getIssues(projectId).then(setIssues).catch(() => setIssues([]));
};
useLiveQuery(load, { types: ['issue'], projectId });
```

(The hook's mount-effect replaces the old `useEffect(load, [projectId])` — the filterKey includes projectId, so navigation between projects still reloads. Keep the existing `load()` calls after local mutations — self-echo suppression makes them non-duplicative.)

Per-screen filters:
| Screen | filter |
|---|---|
| ProjectIssues | `{ types: ['issue'], projectId }` |
| ProjectRfis | `{ types: ['rfi'], projectId }` |
| ProjectPunch | `{ types: ['punch'], projectId }` |
| ProjectNotes | `{ types: ['note'], projectId }` |
| TasksPage | `{ types: ['task'] }` on its `reload` (TasksPage.tsx:31); leave its URL-scope effect (line 45) untouched — the hook replaces only the mount/reload effect (line 37). Read the file: if `reload` also loads users/projects/customers, keep that in `reload` — over-fetching a few lookups on task events is fine. |

- [ ] **Step 1: Write the failing RTL test** (pattern: partial store mock per `ProjectStageControl.test.tsx`, fake socket via mocked CollaborationContext as in Task 4's test):

```tsx
// src/pages/project/ProjectIssues.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor as rtlWaitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

const { fakeSocket, getIssues } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return { fakeSocket, getIssues: vi.fn() };
});
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()), getIssues,
}));
vi.mock('./ProjectLayout', () => ({
  useProjectOutlet: () => ({ summary: { name: 'P1', contractor: '' } }),
}));

import { ProjectIssues } from './ProjectIssues';

function mount() {
  return render(
    <MemoryRouter initialEntries={['/project/p1/issues']}>
      <Routes><Route path="/project/:projectId/issues" element={<ProjectIssues />} /></Routes>
    </MemoryRouter>
  );
}

describe('ProjectIssues live refresh', () => {
  beforeEach(() => {
    getIssues.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });

  it('refetches when a foreign issue event for this project arrives', async () => {
    getIssues.mockResolvedValueOnce([]);
    getIssues.mockResolvedValueOnce([{ id: 'i1', number: 1, title: 'new crack', status: 'open', photoCount: 0 }]);
    mount();
    await rtlWaitFor(() => expect(getIssues).toHaveBeenCalledTimes(1));
    act(() => {
      fakeSocket.fire('entity-changed', { type: 'issue', id: 'i1', projectId: 'p1', action: 'created', bySessionId: 'other-tab' });
    });
    await rtlWaitFor(() => expect(getIssues).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await rtlWaitFor(() => expect(screen.getByText('new crack')).toBeInTheDocument());
  });

  it('ignores issue events for other projects', async () => {
    getIssues.mockResolvedValue([]);
    mount();
    await rtlWaitFor(() => expect(getIssues).toHaveBeenCalledTimes(1));
    act(() => {
      fakeSocket.fire('entity-changed', { type: 'issue', id: 'iX', projectId: 'OTHER', action: 'created', bySessionId: 'other-tab' });
    });
    await new Promise(r => setTimeout(r, 500));
    expect(getIssues).toHaveBeenCalledTimes(1);
  });
});
```

(This uses the real 300ms debounce with real timers — hence the generous rtlWaitFor timeout. If flaky, pass a ToastProvider/ConfirmProvider wrapper as the component requires — read its imports and wrap accordingly; `ProjectStageControl.test.tsx` shows the ToastProvider pattern.)

- [ ] **Step 2: Run to verify it fails** (component still uses plain useEffect — the event does nothing).
- [ ] **Step 3: Convert all five screens** per the table.
- [ ] **Step 4: Run** — new test passes; `npx vitest run --project ui` all green; `npm run lint` clean.
- [ ] **Step 5: Commit**

```bash
git add src/pages/project/ProjectIssues.tsx src/pages/project/ProjectIssues.test.tsx src/pages/project/ProjectRfis.tsx src/pages/project/ProjectPunch.tsx src/pages/project/ProjectNotes.tsx src/pages/TasksPage.tsx
git commit -m "feat(realtime): issues/rfis/punch/notes/tasks screens live-refresh on change feed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Convert billing, documents, lists, and the project shell (batch 2)

**Files:**
- Modify: `src/pages/project/ProjectBilling.tsx:58-80`, `src/pages/project/billing/InvoicesSection.tsx`, `src/pages/project/billing/ChangeOrdersSection.tsx`, `src/pages/project/billing/AiaPayApplications.tsx`, `src/pages/project/billing/AiaScheduleOfValues.tsx`, `src/pages/documents/DocumentsPage.tsx:121-145`, `src/pages/ProjectsPage.tsx:262`, `src/pages/customers/CustomersSplitView.tsx:28`, `src/pages/UsersView.tsx:30`, `src/pages/TimeKeeping.tsx:203-238`, `src/pages/project/ProjectLayout.tsx`, `src/pages/ProjectView.tsx`
- Test: reuse the Task 5 RTL pattern for ONE representative (`src/pages/documents/DocumentsPage.test.tsx` — it has the trickiest filter identity)

**Interfaces:** Consumes `useLiveQuery`. Filters (read each file's actual load function before converting — line refs drift):

| Screen | filter | notes |
|---|---|---|
| ProjectBilling (host `load` + `reloadSummary`) | `{ types: ['invoice','changeOrder','payment','aiaSov','aiaPayApp','project'], projectId }` on `reloadSummary`; keep `load` (full) on mount via the hook with same filter | billing summary aggregates everything |
| InvoicesSection | `{ types: ['invoice','payment'], projectId }` on its internal reload | |
| ChangeOrdersSection | `{ types: ['changeOrder'], projectId }` | |
| AiaPayApplications | `{ types: ['aiaPayApp','payment'], projectId }` | |
| AiaScheduleOfValues | `{ types: ['aiaSov','changeOrder'], projectId }` | CO approval syncs SOV |
| DocumentsPage | `{ types: ['file'] }` on `refresh` — keep the existing `requestIdRef` race guard; the hook's debounced call goes through the same `refresh` | its `[filterKey]` effect stays; the hook replaces only the event-driven refresh (add hook alongside, do NOT remove the filter effect — pass the hook a no-op-safe `refresh`) — concretely: `useLiveQuery(refresh, { types: ['file'] })` and DELETE the old mount-only effect if `refresh` is otherwise identical; keep exactly one mount-load path |
| ProjectsPage | `{ types: ['project','customer','invoice','aiaPayApp','payment'] }` on `load` | card totals move with billing |
| CustomersSplitView | `{ types: ['customer','project','invoice','payment','aiaPayApp','task'] }` on `load` | outstanding rollups |
| UsersView | `{ types: ['user'] }` on `fetchUsers` | |
| TimeKeeping | `{ types: ['timeEntry'] }` on `fetchEntries` (and `fetchTeamEntries` — one hook per load fn is fine) | |
| ProjectLayout | `{ types: ['project'], projectId, id: projectId }` on its summary load (read the file for the fn name) | keeps header/name fresh |
| ProjectView | `{ types: ['project'], projectId, id: projectId }` calling its existing `loadProject` (ProjectView.tsx:479) | self-echo suppression prevents own-save reload loops; foreign project saves refresh pages/takeoffs |

- [ ] **Step 1: Write the failing DocumentsPage test** (same shape as Task 5's: mock `getDocuments`, fire a `{type:'file'}` event, assert refetch; assert an event with `bySessionId: CLIENT_SESSION_ID` does NOT refetch — import the real constant).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Convert all screens** per the table. For ProjectView: add the hook near the other effects; do not restructure anything else in the monolith.
- [ ] **Step 4: Run** — full ui + server suites, lint.
- [ ] **Step 5: Commit**

```bash
git add src/pages/project/ProjectBilling.tsx src/pages/project/billing/InvoicesSection.tsx src/pages/project/billing/ChangeOrdersSection.tsx src/pages/project/billing/AiaPayApplications.tsx src/pages/project/billing/AiaScheduleOfValues.tsx src/pages/documents/DocumentsPage.tsx src/pages/documents/DocumentsPage.test.tsx src/pages/ProjectsPage.tsx src/pages/customers/CustomersSplitView.tsx src/pages/UsersView.tsx src/pages/TimeKeeping.tsx src/pages/project/ProjectLayout.tsx src/pages/ProjectView.tsx
git commit -m "feat(realtime): billing/documents/lists/project shell live-refresh

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Editing presence — server event, client hook, banner, chip

**Files:**
- Modify: `server/realtime/registerRealtime.ts` (new `set-editing` handler)
- Create: `src/hooks/useCollabEditing.ts`, `src/components/EditPresenceBanner.tsx`, `src/components/EditingChip.tsx`
- Test: `server/realtime/registerRealtime.editing.test.ts`, `src/hooks/useCollabEditing.test.tsx`

**Interfaces:**
- Produces (server wire): C→S `set-editing` with `{ type: string, id: string } | null` → validates, `registry.update(sessionId, { editing })`, `io.emit('session-updated', publicSession(s))`. Cleared implicitly when the session dies (registry removal) — no lock table, nothing persisted.
- Produces (`useCollabEditing.ts`):

```ts
import type { SessionView } from '../context/CollaborationContext';
import type { EntityType, EntityChangedEvent } from './useLiveQuery';

export interface CollabEditingState {
  othersEditing: SessionView[];               // sessions (not mine) editing this entity
  remoteChange: EntityChangedEvent | null;    // set when a foreign change arrived while dirty
  keepMineVersion: number | null;             // adopt into the save payload after "Keep mine"
  reviewMerge: () => void;                    // calls onFresh (parent refetch → key-remount) and clears state
  keepMine: () => void;                       // records the remote version, clears the banner
}

export function useCollabEditing(args: {
  type: EntityType;
  id: string;
  isDirty: () => boolean;
  onFresh: () => void;    // parent's refetch — editors are remounted via key={id:version}
}): CollabEditingState;
```

Behavior: on mount/id change emit `set-editing {type,id}`; cleanup emits `set-editing null`; re-emits on socket `connect` (reconnects wipe server session state). Subscribes to `entity-changed` for exactly this type+id, skipping self-echo (`CLIENT_SESSION_ID`): pristine (`!isDirty()`) → call `onFresh()` immediately (silent reload); dirty → set `remoteChange`. `othersEditing` derives from `useCollaboration().sessions` filtered by `editing` match and `sessionId !== mySessionId`.

- Produces (`EditPresenceBanner.tsx`):

```tsx
export const EditPresenceBanner: React.FC<{ state: CollabEditingState }> = ...
```
Renders nothing when `othersEditing` empty and no `remoteChange`. Otherwise a slim amber bar at the top of the editor: "«name» («device») is editing this too" (joined names for several), and when `remoteChange` is set: "«name» saved changes while you were editing" with two buttons: **Review & merge** (`state.reviewMerge`) and **Keep mine** (`state.keepMine`, subtitle "overwrites their change on save"). Style with existing Tailwind idiom (`rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs` — match the app's token classes by reading one existing warning banner, e.g. in ProjectSettings, and reuse its classes).

- Produces (`EditingChip.tsx`):

```tsx
export const EditingChip: React.FC<{ type: EntityType; id: string }> = ...
```
Uses `useCollaboration().sessions`; when someone else is editing `type:id`, renders a tiny inline chip (`<span>` with a pencil glyph + first editor's name, amber); otherwise null. Safe to drop into any table cell.

- [ ] **Step 1: Write the failing server test**

```ts
// server/realtime/registerRealtime.editing.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startRealtimeServer, connectClient, makeToken, waitFor } from './testHarness';

describe('set-editing', () => {
  let srv: Awaited<ReturnType<typeof startRealtimeServer>>;
  beforeEach(async () => { srv = await startRealtimeServer(); });
  afterEach(async () => { await srv.close(); });

  it('sets editing on the session and broadcasts session-updated to everyone (incl. self)', async () => {
    const a = connectClient(srv.port, makeToken({ id: 'u1', username: 'a' }));
    const aSnap = await waitFor<{ selfId: string }>(a, 'sessions-snapshot');
    const b = connectClient(srv.port, makeToken({ id: 'u2', username: 'b' }));
    await waitFor(b, 'sessions-snapshot');

    const bSees = waitFor<any>(b, 'session-updated');
    const aSees = waitFor<any>(a, 'session-updated');
    a.emit('set-editing', { type: 'invoice', id: 'inv1' });
    expect((await bSees).editing).toEqual({ type: 'invoice', id: 'inv1' });
    expect((await aSees).sessionId).toBe(aSnap.selfId);

    const cleared = waitFor<any>(b, 'session-updated');
    a.emit('set-editing', null);
    expect((await cleared).editing).toBeNull();
    expect(srv.handle.registry.get(aSnap.selfId)?.editing).toBeNull();
    a.close(); b.close();
  });

  it('ignores malformed payloads', async () => {
    const a = connectClient(srv.port, makeToken());
    const snap = await waitFor<{ selfId: string }>(a, 'sessions-snapshot');
    a.emit('set-editing', { type: 5 });
    a.emit('set-editing', 'garbage');
    await new Promise(r => setTimeout(r, 100));
    expect(srv.handle.registry.get(snap.selfId)?.editing).toBeNull();
    a.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**, then implement the handler in `registerRealtime.ts` (inside the connection handler, near `update-user`):

```ts
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
```

- [ ] **Step 3: Write the failing client hook test** (same fake-socket + mocked context pattern as Task 4; mock `useCollaboration` to return `sessions` containing another session with `editing: {type:'task', id:'t1'}` and assert `othersEditing` surfaces it; fire a foreign `entity-changed` for `task:t1` with `isDirty: () => false` and assert `onFresh` called; with `isDirty: () => true` assert `remoteChange` set and `keepMine()` yields `keepMineVersion === event.version`; assert mount emitted `set-editing {type,id}` and unmount emitted `set-editing null`).

```tsx
// src/hooks/useCollabEditing.test.tsx — skeleton to write out fully
// (identical fakeSocket + vi.mock('../context/CollaborationContext') scaffolding as useLiveQuery.test.tsx,
//  but useCollaboration returns { socket: fakeSocket, mySessionId: 'me', sessions: [ME, OTHER] } where
//  OTHER = { sessionId: 'other', userId:'u2', name:'sam', role:'user', color:'#000', device:'Mac · Safari',
//            location:null, editing:{type:'task',id:'t1'}, cursor:null, lastActive:1 } )
// Tests:
//  1. renders othersEditing = [OTHER] for {type:'task', id:'t1'}, [] for id:'t2'
//  2. mount emits set-editing {type:'task',id:'t1'}; unmount emits set-editing null
//  3. entity-changed for task:t1 (foreign) with isDirty=false → onFresh called once, remoteChange stays null
//  4. same with isDirty=true → onFresh NOT called, remoteChange=event; keepMine() → keepMineVersion=event.version, remoteChange null
//  5. self-echo event (bySessionId=CLIENT_SESSION_ID) → ignored entirely
```

- [ ] **Step 4: Implement** `useCollabEditing.ts`, `EditPresenceBanner.tsx`, `EditingChip.tsx` per the Interfaces block.

```ts
// src/hooks/useCollabEditing.ts
import { useEffect, useRef, useState } from 'react';
import { useCollaboration, type SessionView } from '../context/CollaborationContext';
import { CLIENT_SESSION_ID } from '../utils/clientSession';
import type { EntityType, EntityChangedEvent } from './useLiveQuery';

export interface CollabEditingState {
  othersEditing: SessionView[];
  remoteChange: EntityChangedEvent | null;
  keepMineVersion: number | null;
  reviewMerge: () => void;
  keepMine: () => void;
}

export function useCollabEditing(args: {
  type: EntityType; id: string; isDirty: () => boolean; onFresh: () => void;
}): CollabEditingState {
  const { socket, sessions, mySessionId } = useCollaboration();
  const [remoteChange, setRemoteChange] = useState<EntityChangedEvent | null>(null);
  const [keepMineVersion, setKeepMineVersion] = useState<number | null>(null);
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => {
    if (!socket) return;
    const declare = () => socket.emit('set-editing', { type: args.type, id: args.id });
    declare();
    socket.on('connect', declare); // reconnect wipes server session state
    const onEvent = (ev: EntityChangedEvent) => {
      if (ev.bySessionId === CLIENT_SESSION_ID) return;
      if (ev.type !== argsRef.current.type || ev.id !== argsRef.current.id) return;
      if (!argsRef.current.isDirty()) argsRef.current.onFresh();
      else setRemoteChange(ev);
    };
    socket.on('entity-changed', onEvent);
    return () => {
      socket.off('connect', declare);
      socket.off('entity-changed', onEvent);
      socket.emit('set-editing', null);
    };
  }, [socket, args.type, args.id]);

  const othersEditing = sessions.filter(s =>
    s.sessionId !== mySessionId && s.editing?.type === args.type && s.editing.id === args.id);

  return {
    othersEditing,
    remoteChange,
    keepMineVersion,
    reviewMerge: () => { setRemoteChange(null); argsRef.current.onFresh(); },
    keepMine: () => { setKeepMineVersion(remoteChange?.version ?? null); setRemoteChange(null); },
  };
}
```

- [ ] **Step 5: Run everything** — both new test files + full suites + lint.
- [ ] **Step 6: Commit**

```bash
git add server/realtime/registerRealtime.ts server/realtime/registerRealtime.editing.test.ts src/hooks/useCollabEditing.ts src/hooks/useCollabEditing.test.tsx src/components/EditPresenceBanner.tsx src/components/EditingChip.tsx
git commit -m "feat(realtime): editing presence — set-editing event, useCollabEditing, banner + chip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Wire editors batch 1 (Task, Issue, RFI, Punch) + their list chips

**Files:**
- Modify: `src/pages/tasks/TaskEditor.tsx`, `src/pages/project/issues/IssueEditor.tsx`, `src/pages/project/rfi/RfiEditor.tsx`, `src/pages/project/punch/PunchItemEditor.tsx`
- Modify (chips): `src/pages/TasksPage.tsx` (task rows), `src/pages/project/ProjectIssues.tsx` (issue rows), `src/pages/project/ProjectRfis.tsx`, `src/pages/project/ProjectPunch.tsx`
- Test: `src/pages/tasks/TaskEditor.test.tsx` (new, representative)

**Interfaces:** Consumes `useCollabEditing`, `EditPresenceBanner`, `EditingChip` (Task 7). Worked example — TaskEditor (it already computes `dirty` at TaskEditor.tsx:58-65):

```tsx
// inside TaskEditor component body, after the dirty computation:
const collab = useCollabEditing({
  type: 'task',
  id: task.id,
  isDirty: () => dirty,
  onFresh: onSaved,   // parent refetches the task and (via key remount) resets this form
});

// in handleSave (TaskEditor.tsx:70), override the version when Keep-mine was chosen:
await saveTask(task.id, {
  ...task,
  ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
  category, title, notes, assigneeUserId, dueDate: dueDate || null, projectId, customerId,
});

// at the top of the Modal body JSX:
<EditPresenceBanner state={collab} />
```

For the other three editors: same three touches (hook + banner + version override in the save payload). Each editor already holds the entity as a prop and has an `onSaved` that refetches (ProjectIssues.tsx:111 etc.). **Dirty detection**: TaskEditor has `dirty`; for IssueEditor/RfiEditor/PunchItemEditor read each file — if no dirty flag exists, add one by snapshotting the initial form fields the same way TaskEditor compares prop vs state (compare each form-state field against the entity prop; a one-expression `const dirty = ...` mirroring TaskEditor.tsx:58-65). Do not add generic deep-diff machinery.

**Parents must remount the editor on fresh data.** ProjectIssues already keys the editor with `` key={`${editing.id}:${editing.version}`} `` (ProjectIssues.tsx:105). Verify the other three parents (TasksPage, ProjectRfis, ProjectPunch) key their editor the same way; add the key where missing — without it, `onFresh` refetches but the form keeps stale state.

**Chips:** in each list's row render, add `<EditingChip type="task" id={t.id} />` (etc.) beside the title cell.

- [ ] **Step 1: Write the failing TaskEditor test** (fake socket + mocked context per Task 7's pattern; mock `saveTask`; render with a task; assert: mount emitted `set-editing {type:'task',id}`; fire foreign `entity-changed` for the task while pristine → `onSaved` called; make a field dirty (fireEvent.change on the title input), fire event → banner text appears; click "Keep mine", click Save → `saveTask` called with `version` = event version).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Wire all four editors + parents' keys + chips.**
- [ ] **Step 4: Run** — ui suite + lint.
- [ ] **Step 5: Commit**

```bash
git add src/pages/tasks/TaskEditor.tsx src/pages/tasks/TaskEditor.test.tsx src/pages/project/issues/IssueEditor.tsx src/pages/project/rfi/RfiEditor.tsx src/pages/project/punch/PunchItemEditor.tsx src/pages/TasksPage.tsx src/pages/project/ProjectIssues.tsx src/pages/project/ProjectRfis.tsx src/pages/project/ProjectPunch.tsx
git commit -m "feat(realtime): edit awareness in task/issue/rfi/punch editors + list chips

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Wire editors batch 2 (billing, settings, proposal, notes)

**Files:**
- Modify: `src/pages/project/billing/InvoiceEditor.tsx`, `src/pages/project/billing/ChangeOrderEditor.tsx`, `src/pages/project/billing/AiaPayAppEditor.tsx`, `src/pages/project/billing/AiaScheduleOfValues.tsx`, `src/pages/project/ProjectSettings.tsx`, `src/pages/project/ProjectProposal.tsx`, `src/pages/project/ProjectNotes.tsx`
- Modify (chips): `src/pages/project/billing/InvoicesSection.tsx`, `src/pages/project/billing/ChangeOrdersSection.tsx`, `src/pages/project/billing/AiaPayApplications.tsx`
- Test: extend the Task 8 pattern with ONE more editor test only if a structural difference forces it (AiaPayAppEditor fetches internally — otherwise no new tests; the hook itself is already covered)

**Interfaces:** Same three touches per editor. Entity types: InvoiceEditor → `'invoice'`, ChangeOrderEditor → `'changeOrder'`, AiaPayAppEditor → `'aiaPayApp'` (it holds `payAppId` — `id: payAppId`; `onFresh` = its internal refetch fn, read the file), AiaScheduleOfValues → `'aiaSov'` with `id: projectId` — CAREFUL: SOV events carry per-line ids; instead subscribe with `useLiveQuery` semantics: for this inline (non-modal) section, skip `useCollabEditing`'s entity-id matching and use: editing declaration `{type:'aiaSov', id: projectId}` (page-level) + its existing Task 6 `useLiveQuery` refetch; add only the banner's `othersEditing` half (pass a state with `remoteChange: null`). ProjectSettings → `'project'`, `id: projectId`, dirty = its existing form-state comparison (read the file; if none, snapshot-compare like Task 8), `onFresh` = its own reload fn. ProjectProposal + ProjectNotes → editing declaration + `othersEditing` banner only (their content autosaves/drafts; the dirty-merge flow doesn't apply — `remoteChange` stays null by passing `isDirty: () => false` and `onFresh` = their reload, which gives silent live refresh).

- [ ] **Step 1: Wire each file** per the mapping (read each before editing; keep the three-touch pattern; parents key remounts like Task 8).
- [ ] **Step 2: Run** — full ui suite + lint (existing editor tests, e.g. AiaPayAppEditor.test.tsx, must still pass — the hook must tolerate the mocked context ABSENT a socket: `useCollabEditing` already no-ops when `socket` is null, and `useCollaboration` throws outside the provider — check those tests' wrappers; if they render without CollaborationProvider, wrap the hook's context use in a safe accessor: import `useContext(CollaborationContext)` directly and tolerate undefined rather than throwing. Decide by reading the failing tests; prefer wrapping test renders in the provider ONLY if trivial, else the tolerant accessor).
- [ ] **Step 3: Commit**

```bash
git add src/pages/project/billing/InvoiceEditor.tsx src/pages/project/billing/ChangeOrderEditor.tsx src/pages/project/billing/AiaPayAppEditor.tsx src/pages/project/billing/AiaScheduleOfValues.tsx src/pages/project/ProjectSettings.tsx src/pages/project/ProjectProposal.tsx src/pages/project/ProjectNotes.tsx src/pages/project/billing/InvoicesSection.tsx src/pages/project/billing/ChangeOrdersSection.tsx src/pages/project/billing/AiaPayApplications.tsx
git commit -m "feat(realtime): edit awareness in billing/settings/proposal/notes editors + chips

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Replace the 409 hard-reload with in-place refresh

**Files:**
- Modify: `src/components/ProjectConflictListener.tsx` (full rewrite), `src/utils/store.ts` (`getProject` records `latestVersions`), `src/pages/ProjectView.tsx` (listen for `project-refreshed`)
- Test: `src/components/ProjectConflictListener.test.tsx` (new)

**Interfaces:**
- Produces: window event `'project-refreshed'` with `detail: { projectId: string, project: Project }`, dispatched by the listener after a successful refetch. `ProjectView` subscribes: when `detail.projectId` matches its project, it replaces its project state via the same path `loadProject` uses (read ProjectView.tsx:479 and reuse its state-setting; simplest correct form: just call `loadProject(projectId)` on the event and ignore `detail.project`).
- `getProject` in store.ts must do `latestVersions.set(project.id, project.version)` after fetching (find `getProject` and add the line; this heals the stale-version map that caused repeat 409s).

New `ProjectConflictListener`:

```tsx
import { useEffect, useRef } from 'react';
import { useToast } from './Toast';
import { getProject } from '../utils/store';

// Project version conflicts (48 saveProject call sites) once triggered a full
// page reload. With the live change feed, conflicts are rare races; recover
// in place: refetch the project, announce it, and let mounted screens re-render.
export default function ProjectConflictListener() {
  const { toast } = useToast();
  const refreshing = useRef(false);

  useEffect(() => {
    const onConflict = async (e: Event) => {
      const projectId = (e as CustomEvent).detail?.projectId as string | undefined;
      if (!projectId || refreshing.current) return;
      refreshing.current = true;
      try {
        const project = await getProject(projectId);
        window.dispatchEvent(new CustomEvent('project-refreshed', { detail: { projectId, project } }));
        toast('This project was changed elsewhere — refreshed with the latest.', { type: 'info' });
      } catch {
        // Refetch failed (offline?): fall back to the old behavior rather than leave a stale tab.
        toast('This project was changed elsewhere — reloading…', { type: 'error' });
        setTimeout(() => window.location.reload(), 2000);
      } finally {
        refreshing.current = false;
      }
    };
    window.addEventListener('project-conflict', onConflict);
    return () => window.removeEventListener('project-conflict', onConflict);
  }, [toast]);

  return null;
}
```

(Check `getProject`'s actual exported name/signature in store.ts first — if it's named differently, e.g. `loadProject`/`fetchProject`, use that. ProjectStageControl.tsx:49's duplicate dispatch stays — the listener is now idempotent-ish via `refreshing` and non-destructive.)

- [ ] **Step 1: Write the failing test** — RTL: mock `getProject` (partial store mock); render listener inside ToastProvider; dispatch `project-conflict` with `{detail:{projectId:'p1'}}`; assert `getProject` called with 'p1' and a `project-refreshed` CustomEvent fired (add a window listener in the test); assert `window.location.reload` NOT called (spy via `vi.spyOn` on a stubbed location — jsdom: `Object.defineProperty(window, 'location', ...)` or simpler, assert no reload by mocking `getProject` to resolve). Second test: `getProject` rejects → falls back (assert toast text appears; reload timer — use fake timers, assert `location.reload` spy called after 2000ms).
- [ ] **Step 2: Run to verify it fails** (current implementation always reloads).
- [ ] **Step 3: Implement all three file changes.** In ProjectView, add:

```tsx
useEffect(() => {
  const onRefreshed = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.projectId === projectId) loadProject(projectId);
  };
  window.addEventListener('project-refreshed', onRefreshed);
  return () => window.removeEventListener('project-refreshed', onRefreshed);
}, [projectId]);
```

(Adapt to `loadProject`'s real signature at ProjectView.tsx:479.)

- [ ] **Step 4: Run** — new test + full suites + lint.
- [ ] **Step 5: Commit**

```bash
git add src/components/ProjectConflictListener.tsx src/components/ProjectConflictListener.test.tsx src/utils/store.ts src/pages/ProjectView.tsx
git commit -m "feat(realtime): 409 conflicts refresh in place instead of reloading the page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: E2E, checklist, push

**Files:**
- Create: `e2e/collab-live-refresh.spec.ts`
- Modify: `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md` (WS2 section)

- [ ] **Step 1: Full unit + lint** — `npm run test` and `npm run lint` green.

- [ ] **Step 2: Write the two-context e2e** (model on `e2e/collab-presence.spec.ts` — same `openAuthedContext` helper pattern):
  1. **Live list refresh:** contexts A and B both open the same project's Issues tab. A creates an issue via the form. Assert B's table shows the new issue's title WITHOUT B navigating or reloading (`expect(bPage.getByText(title)).toBeVisible({ timeout: 15_000 })`).
  2. **Edit banner:** A and B both open the same issue's editor. Assert A's editor shows an edit-presence banner naming the other session (both are "admin" — assert on the banner's role text presence, e.g. `getByText(/is editing this too/)`).
  3. **Live refresh survives into the editor list:** A saves a change to the issue title; assert B's open list reflects it.

- [ ] **Step 3: Run** — `npm run test:e2e` (whole suite, single worker).

- [ ] **Step 4: Update the checklist** — tick every WS2 item with its delivering commit hashes; REWRITE the carried item "`X-Session-Id` must read the CURRENT socket id fresh…" to: "`X-Session-Id` is a stable per-tab client id (`CLIENT_SESSION_ID`), decoupled from the reconnect-sensitive socket id (`hash`)" and tick it; tick the verifyToken normalization item. Do not touch other workstreams.

- [ ] **Step 5: Commit and push**

```bash
git add e2e/collab-live-refresh.spec.ts docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md
git commit -m "test(realtime): two-context live-refresh + edit-banner e2e; WS2 checklist complete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin testing
```

---

## Self-Review Notes

- **Spec §4 coverage:** broadcastChange at mutation sites (T2/T3), no-payload event + session meta (T1), `X-Session-Id` (T4 — stable-tab-id design supersedes both the spec's socket-session wording and the carried checklist line; ruled), `useLiveQuery` with self-echo/debounce/version-skip/reconnect (T4), section conversions (T5/T6 — dashboard + activity feed intentionally deferred to WS3 per checklist note), editing presence + banner + chips (T7-T9), pristine-silent-reload / dirty Review-merge-Keep-mine (T7 hook + T8/T9 wiring), 409 replacement (T10), e2e (T11).
- **Deviations (ruled, documented in Global Constraints):** global emit instead of project-room emit; stable client tab id instead of socket sessionId for self-echo.
- **Type consistency:** `EntityType`/`EntityChangedEvent` defined twice (server `changeFeed.ts`, client `useLiveQuery.ts`) — field lists must match exactly; both are specified verbatim above. `CollabEditingState` names (`othersEditing/remoteChange/keepMineVersion/reviewMerge/keepMine`) used identically in T7 code, T8 wiring, and banner props. `set-editing` payload shape consistent between server test, handler, and client hook.
- **Known risk areas for reviewers:** ProjectView conversion (monolith — the hook must not fight its save queue; self-echo suppression is the guard), Task 9's provider-absent test tolerance decision, DocumentsPage double-load avoidance (exactly one mount-load path).
- Line numbers throughout are as of commit `e914d84` — locate by symbol/route when they drift.
