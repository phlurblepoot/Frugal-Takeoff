# WS4 — Canvas Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measurement edits become server-applied operations (persisted row-by-row with a version bump in the broadcast and join-time backfill), drawing decouples from the full-project PUT, cursors throttle, the WS1 compat shim and dead wires die, and the carried Follow-rename/race-fix lands.

**Architecture:** A new `server/realtime/measurementOps.ts` applies `add/update/delete` ops directly to the `measurements` table (same row shape `decomposeProject` writes) inside a transaction that bumps `projects.version`; a ported `server/realtime/revisionModel.ts` rejects ops on superseded pages server-side. The socket layer replaces the shim's blind `measurement-update` relay with an acked `measurement-op` (membership = sender in the page's `project:` room — satisfying the carried cross-page finding) plus a `canvas-join` ack that returns the page's current measurements + project version (backfill). CanvasView's five measurement emit sites stop calling `saveProject` for measurement CRUD and instead send ops, adopting the acked version so the full-PUT path (still used for scale/regions/page ops) never goes stale. Everything else — cursor throttling, Follow rename + effect merge, wording nits — rides along.

**Tech Stack:** better-sqlite3 (sync transactions), socket.io acks (new `emitWithAck` harness helper), React 19, Playwright two-context specs with screenshots.

**Spec:** `docs/superpowers/specs/2026-08-23-realtime-collaboration-design.md` (§6 = WS4). Progress: `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md` — tick WS4 items with hashes in the same commit as the work.

## Global Constraints

- No secure-context browser APIs in `src/**` (uuid package). No schema/migration changes (the `measurements` table as-is suffices). SQLite `journal_mode = DELETE` untouched. Single-process.
- All existing tests keep passing (`npm run test` 1131+, `npm run lint` clean, `npm run test:e2e` 51+). **Canvas changes are verified with real Playwright click-drag + screenshots (standing repo rule).**
- Git: commit per task on `testing`; push only in the final task; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Op semantics: last-writer-wins per measurement, server-applied in arrival order (spec §6) — NO version check on ops; the project `version` still bumps per op so the whole-project PUT path stays conflict-safe.
- The op broadcast carries the new project `version`; sender (via ack) AND receivers adopt it (`noteProjectVersion` + local state) so nobody holds a stale version.
- `entity-changed {type:'project'}` still fires per applied op (preserves WS2's live totals/dashboard behavior — identical event rate to today's PUT-per-edit, and clients debounce).
- **Ruled (mid-drag throttling):** exploration proved measurement updates already emit only on drag-END (`PdfCanvas` onDragMove is local-only); the spec's "mid-drag throttling" clause has nothing to throttle. Only cursors get the rAF + min-distance gate. Ledger this; do not invent mid-drag streaming.
- **Accepted residual risk (document, don't fix):** the full-project PUT (`decomposeProject` delete-and-reinsert) can still clobber a measurement drawn by another user in the tiny window before the receiver's state adopts the broadcast — same-or-smaller risk than today (receivers now adopt broadcasts + versions immediately). WS5 does not build on this path.

## File Structure

| File | Responsibility |
|---|---|
| Create `server/realtime/revisionModel.ts` (+test) | server-side port: `effectiveSheetId(page)`, `isPageSuperseded(db, projectId, pageId)` |
| Create `server/realtime/measurementOps.ts` (+test) | `applyMeasurementOp(db, op)` — row write + version bump, validation |
| Modify `server/realtime/registerRealtime.ts` (+tests) | `measurement-op` + `canvas-join` handlers; shim deletion; `RealtimeOptions.db` |
| Modify `server/realtime/testHarness.ts` | `emitWithAck(socket, event, payload)` helper; optional db wiring |
| Modify `server.ts` | pass `db` + `broadcastChange` into `registerRealtime` |
| Modify `src/context/CollaborationContext.tsx` (+tests) | `sendMeasurementOp`/`onMeasurementApplied`/`joinCanvas`; dead-wire deletion; Follow rename + merged effects |
| Modify `src/utils/store.ts` | export `noteProjectVersion(projectId, version)` |
| Modify `src/pages/CanvasView.tsx` | 5 op sites decoupled from saveProject; receiver adopts version; backfill; onProjectSync deleted |
| Modify `src/components/PdfCanvas.tsx` | cursor rAF + min-distance throttle |
| Modify `src/components/UserPresenceOverlay.tsx`, `src/components/FollowPill.tsx`, `src/pages/ProjectsPage.tsx` (+tests) | Follow rename fallout + wording nits |
| Create `e2e/collab-canvas-sync.spec.ts` | two-context draw/drag/backfill proof + screenshots |

---

### Task 1: Server-side revision model port

**Files:**
- Create: `server/realtime/revisionModel.ts`
- Test: `server/realtime/revisionModel.test.ts`

**Interfaces:**
- Consumes: the client reference implementation `src/utils/planSets.ts` (`computeRevisionModel`, `effectiveSheetId`) — READ IT FIRST; this port must agree with it. DB tables: `pages (id, projectId, planSetId, pageNumber, attrs)`, `plan_sets (id, projectId, sortOrder)`.
- Produces:

```ts
// Row-level inputs deliberately mirror what a cheap query returns.
export interface PageRow { id: string; planSetId: string | null; pageNumber: string | null; attrs: string | null; }

// attrs JSON may carry sheetId (migration 15). Fallback chain matches the client:
// attrs.sheetId || 'pn:' + normalized pageNumber || 'id:' + page id
export function effectiveSheetIdFromRow(row: PageRow): string;

// A page is superseded when its sheet has >1 revision and this page is not the
// latest (latest = the sheet's page in the plan_set with the highest sortOrder;
// ties broken by plan_set insertion order exactly as the client model does —
// read computeRevisionModel and match its ordering rule precisely).
export function isPageSuperseded(db: Database, projectId: string, pageId: string): boolean;
```

- [ ] **Step 1: Read `src/utils/planSets.ts`** — extract the exact ordering rule (how revisions are ordered across plan_sets; what "latest" means; the pageNumber normalization: trim + lowercase per the exploration).

- [ ] **Step 2: Write the failing test** — in-memory db + real migrations (copy the beforeEach pattern from `server/routes.changefeed.test.ts`); seed: one project, two plan_sets (sortOrder 0 and 1), pages sharing `pageNumber: 'A-101'` (one per set, attrs carrying the same `sheetId` for one scenario and NO sheetId for a normalized-pageNumber-fallback scenario), plus a unique page. Cases:

```ts
// server/realtime/revisionModel.test.ts — write out fully with the seeding helper inline:
//  1. page in older plan_set with shared sheetId -> superseded = true
//  2. page in newest plan_set with shared sheetId -> false (current)
//  3. unique page (no other revision) -> false
//  4. fallback grouping via normalized pageNumber ('A-101' vs 'a-101 ') when attrs has no sheetId -> older true / newer false
//  5. unknown pageId -> false (treat as not-superseded; the op layer validates existence separately)
//  6. effectiveSheetIdFromRow precedence: attrs.sheetId beats pageNumber beats id
```

- [ ] **Step 3: Run to verify fail; implement** (keep it small: one query for the project's pages + one for plan_set sortOrders, then the same grouping/ordering as the client model).
- [ ] **Step 4: Run** — `npx vitest run --project server server/realtime/revisionModel.test.ts` green; full server project green; lint clean.
- [ ] **Step 5: Commit**

```bash
git add server/realtime/revisionModel.ts server/realtime/revisionModel.test.ts
git commit -m "feat(canvas): server-side revision model — isPageSuperseded

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: applyMeasurementOp

**Files:**
- Create: `server/realtime/measurementOps.ts`
- Test: `server/realtime/measurementOps.test.ts`

**Interfaces:**
- Consumes: `isPageSuperseded` (Task 1). The measurement row shape `decomposeProject` writes (`server/projectStore.ts:214-218`): `{id, pageId, projectId, takeoffId, type, name, color, points: JSON.stringify(points), sortOrder, attrs: JSON.stringify(rest)}` where "rest" = every measurement field except `{id, type, name, color, points, takeoffId}` (read decomposeProject and match its destructuring EXACTLY — heights/isTwoSided/regionId/planSetId/arcMidIndices/segments ride in attrs).
- Produces:

```ts
export type MeasurementOpAction = 'add' | 'update' | 'delete';

export interface MeasurementOp {
  projectId: string;
  pageId: string;
  action: MeasurementOpAction;
  // For delete, only measurement.id is required. For add/update, the full client
  // Measurement object (id, type, points required; everything else optional).
  measurement: Record<string, unknown> & { id: string };
}

export class OpRejectedError extends Error {
  constructor(public reason: 'page_not_found' | 'page_superseded' | 'invalid_measurement') { super(reason); }
}

// Applies the op to the measurements table and bumps projects.version, all in
// one transaction. Ordering = call order (better-sqlite3 is sync). Throws
// OpRejectedError on validation failure; never partially applies.
export function applyMeasurementOp(db: Database, op: MeasurementOp): { version: number };
```

Behavior contract (each a test):
1. Page must exist AND belong to `op.projectId` → else `page_not_found`.
2. Superseded page → `page_superseded` (uses Task 1).
3. add/update require `measurement.id` (string), `type` (string), `points` (array) → else `invalid_measurement`. delete requires only id.
4. `add`: INSERT with `sortOrder = MAX(sortOrder)+1` for the page (0 when empty). If the id already exists (double-fire), behave as update (INSERT OR REPLACE preserving the existing row's sortOrder — implement via upsert reading current sortOrder first).
5. `update`: rewrite the row (same attrs-splitting as decomposeProject), preserving existing `sortOrder`; a missing row behaves as add (LWW semantics survive out-of-order delivery).
6. `delete`: `DELETE ... WHERE id = ? AND pageId = ?`; deleting a missing row still succeeds (idempotent) and still bumps the version.
7. Every successful op does `UPDATE projects SET version = version + 1, updatedAt = <now ISO> WHERE id = ?` and returns the new version.
8. Round-trip fidelity: after an `add` with `{heights, isTwoSided, segments, arcMidIndices, regionId, planSetId}`, `loadProject` (projectStore) returns the measurement with all those fields intact (proves the attrs split matches decomposeProject/loadProject).

- [ ] **Step 1: Write the failing test** — in-memory db + migrations (same pattern as Task 1); seed a project via `saveProject`/`createProject` from projectStore (read `server/projectStore.test.ts` for the existing seeding idiom) with one page + one takeoff; write out all 8 cases including the round-trip via `loadProject`.
- [ ] **Step 2: Run to verify fail; implement** per the contract.
- [ ] **Step 3: Run** — new test + full server project + lint.
- [ ] **Step 4: Commit**

```bash
git add server/realtime/measurementOps.ts server/realtime/measurementOps.test.ts
git commit -m "feat(canvas): server-applied measurement ops with version bump

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Socket layer — measurement-op + canvas-join, shim removal

**Files:**
- Modify: `server/realtime/registerRealtime.ts` (shim block ~L130-151; `RealtimeOptions`), `server/realtime/testHarness.ts`, `server.ts` (registerRealtime call)
- Test: `server/realtime/registerRealtime.canvas.test.ts` (new)

**Interfaces:**
- Consumes: `applyMeasurementOp`/`OpRejectedError` (T2), `projectRoom` helper, `BroadcastChange`/`requestMeta`-style meta (byUserId from socket.data.user, bySessionId = the SOCKET session id is NOT the client tab id — for self-echo parity with the change feed, the op payload carries the client's `clientTabId` and the broadcast echoes it; see wire shapes).
- Produces:

```ts
// RealtimeOptions gains (server.ts passes both):
//   db: Database                       — for applyMeasurementOp / canvas-join reads
//   broadcastChange?: BroadcastChange  — to emit entity-changed after each applied op

// C→S 'measurement-op', payload:
//   { pageId: string, projectId: string, action: 'add'|'update'|'delete',
//     measurement: {...}, clientTabId?: string }
//   with ack callback: (res: { ok: true, version: number } | { ok: false, error: string }) => void
//   Membership: socket.rooms.has(projectRoom(projectId)) — the sender must be somewhere
//   in the project (carried WS1 finding: cross-page ops from project members are LEGAL).
//   Rejections: 'not_in_project', 'page_not_found', 'page_superseded', 'invalid_measurement'.
//   On success: applyMeasurementOp → ack {ok:true, version} → socket.to(projectRoom).emit(
//     'measurement-applied', { pageId, action, measurement, version, bySessionId: clientTabId }) →
//     broadcastChange({ type:'project', id: projectId, projectId, version, action:'updated',
//       byUserId: socket.data.user.id, bySessionId: clientTabId })
//
// C→S 'canvas-join', payload { pageId: string, projectId: string },
//   ack: ({ ok: true, measurements: any[], version: number } | { ok: false, error: string })
//   Membership same as above. Reads the page's measurement rows (same hydration as
//   loadProject: parse points, spread attrs) + the project's version.
//
// DELETED: the whole WS1 compat shim 'measurement-update' handler. 'cursor-move'
// SURVIVES (rebranded comment — it is permanent, not shim) unchanged server-side.
```

- `testHarness.ts` gains:

```ts
export function emitWithAck<T = any>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
```
and `startRealtimeServer` accepts optional `{ db, broadcastChange }` passthrough in its opts (defaulting db to undefined keeps old tests working — the new handlers no-op with an `{ok:false, error:'no_db'}` ack when db is absent; existing tests unaffected).

- [ ] **Step 1: Write the failing integration test** — real harness + in-memory db + migrations + a seeded project/page (reuse Task 2's seeding). Cases (write fully):

```ts
// server/realtime/registerRealtime.canvas.test.ts
//  1. sender in project room (set-location to a project path): measurement-op add →
//     ack {ok:true, version:2}; second client in the same project room receives
//     'measurement-applied' with pageId/action/measurement/version/bySessionId='tab-A';
//     db row exists (query measurements).
//  2. cross-page: sender located on page A emits an op for page B (same project) → ok:true
//     (carried WS1 finding).
//  3. sender NOT in the project (located at /dashboard) → ack {ok:false, error:'not_in_project'},
//     no broadcast, no row.
//  4. superseded page → ack {ok:false, error:'page_superseded'} (seed the two-plan-set fixture).
//  5. canvas-join returns {ok:true, measurements:[...with attrs fields spread...], version} for a
//     page with rows; measurements' points are parsed arrays, not JSON strings.
//  6. legacy 'measurement-update' event no longer relays (emit it; assert no 'measurement-sync'
//     within 300ms — the handler is gone).
//  7. entity-changed {type:'project'} observed by a third client after a successful op.
```

- [ ] **Step 2: Run to verify fail; implement** — handlers per the wire contract; delete the shim's `measurement-update` handler + the shim comment brackets (keep `cursor-move` with a fresh comment: "permanent: canvas cursor relay"); wire `db`/`broadcastChange` through `RealtimeOptions` and update `server.ts`'s call (`registerRealtime(io, { verifyToken, db, broadcastChange })` — note `broadcastChange` is created AFTER registerRealtime today; reorder so `createChangeFeed(io)` runs first).
- [ ] **Step 3: Run** — new tests + ALL realtime tests + full server project + lint.
- [ ] **Step 4: Commit**

```bash
git add server/realtime/registerRealtime.ts server/realtime/registerRealtime.canvas.test.ts server/realtime/testHarness.ts server.ts
git commit -m "feat(canvas): acked measurement-op + canvas-join backfill; WS1 shim removed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Client context — op surface, dead-wire deletion, noteProjectVersion

**Files:**
- Modify: `src/context/CollaborationContext.tsx`, `src/utils/store.ts`
- Test: extend `src/context/CollaborationContext.test.tsx`

**Interfaces:**
- Produces (context surface changes — CanvasView consumes in Task 5):

```ts
// REMOVED from CollaborationContextType: sendMeasurementUpdate, onMeasurementSync,
//   sendProjectUpdate, onProjectSync (and the 'project-sync' socket listener + the
//   measurementCallbacks/projectCallbacks ref machinery).
// ADDED:
sendMeasurementOp: (op: { projectId: string; pageId: string; action: 'add'|'update'|'delete';
  measurement: Record<string, unknown> & { id: string } }) =>
  Promise<{ ok: true; version: number } | { ok: false; error: string }>;
  // emits 'measurement-op' with { ...op, clientTabId: CLIENT_SESSION_ID } and resolves the ack;
  // resolves { ok:false, error:'offline' } when socket is null/disconnected.
joinCanvas: (projectId: string, pageId: string) =>
  Promise<{ ok: true; measurements: any[]; version: number } | { ok: false; error: string }>;
onMeasurementApplied: (cb: (ev: { pageId: string; action: 'add'|'update'|'delete';
  measurement: any; version: number; bySessionId?: string }) => void) => () => void;
  // same subscribe-with-cleanup pattern as the old onMeasurementSync; self-echo NOT
  // filtered here (server already excludes the sender socket; bySessionId passes through).
```

- Produces (store.ts): `export function noteProjectVersion(projectId: string, version: number): void` — sets the module's `latestVersions` map (guard: only raise, never lower: `if (version > (latestVersions.get(projectId) ?? 0))`).

- [ ] **Step 1: Write the failing tests** (extend the existing scaffolding): (a) `sendMeasurementOp` emits `'measurement-op'` with `clientTabId` = the real `CLIENT_SESSION_ID` and resolves the ack the fakeSocket passes back (extend fakeSocket: its `emit` mock invokes a provided ack responder when the event is 'measurement-op'); (b) resolves `{ok:false, error:'offline'}` with no socket (render without token); (c) `onMeasurementApplied` callbacks fire on 'measurement-applied' events and unsubscribe cleanly; (d) the context no longer registers a `'project-sync'` listener (assert `fakeSocket.handlers['project-sync']` is undefined). Write them out fully.
- [ ] **Step 2: Run to verify fail; implement** — including deleting the dead-wire pieces and the now-unused callbacks refs; `noteProjectVersion` in store.ts with the only-raise guard.
- [ ] **Step 3: Run** — context tests + FULL ui project (`CanvasView` still imports the deleted names at this point — it must NOT: Task 5 does CanvasView; to keep this task compiling, this task ALSO does the minimal mechanical swap in CanvasView: replace the destructured `sendMeasurementUpdate, onMeasurementSync, sendProjectUpdate, onProjectSync` with the new names and stub the call sites so they compile (`void sendMeasurementOp({...})` fire-and-forget at the 5 sites, `onMeasurementApplied` in place of `onMeasurementSync` with the same handler body, DELETE the onProjectSync effect). Task 5 then finishes the semantic work (version adoption, saveProject decoupling, backfill). Keep this task's CanvasView changes strictly name-level so the diff stays reviewable.) Lint clean; full `npm run test` green.
- [ ] **Step 4: Commit**

```bash
git add src/context/CollaborationContext.tsx src/context/CollaborationContext.test.tsx src/utils/store.ts src/pages/CanvasView.tsx
git commit -m "feat(canvas): client op surface with acks; project-sync dead wire deleted

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CanvasView — decouple drawing from the project PUT; backfill; version adoption

**Files:**
- Modify: `src/pages/CanvasView.tsx`
- Test: existing suites + Task 7's e2e (this task runs the CURRENT canvas e2e specs as its gate)

**Interfaces:** Consumes Task 4's `sendMeasurementOp`/`joinCanvas`/`onMeasurementApplied` and store's `noteProjectVersion`. Behavior contract:

1. **The five measurement sites stop PUTting.** At `handlePaste` (~L238), `addMeasurement` (~L735), `confirmNewMeasurement` (~L814), `updateMeasurement` (~L875), `confirmDeleteMeasurement` (~L930): apply the local state change (as today) but REMOVE the accompanying `saveProject(...)`/`savePageUpdates(...)` call **for the measurement-only mutation**, replacing it with:

```ts
const res = await sendMeasurementOp({ projectId, pageId: page.id, action, measurement });
if (res.ok) {
  noteProjectVersion(projectId, res.version);
  setProject(prev => (prev ? { ...prev, version: res.version } : prev));
} else if (res.error === 'page_superseded') {
  toast('This revision is read-only — reload to see the current one', { type: 'warning' });
} else if (res.error !== 'offline') {
  toast('Sync failed — your change is local only until the next full save', { type: 'warning' });
}
```
   CAREFUL per site: some of these functions ALSO change non-measurement page state (e.g. `confirmNewMeasurement` may touch takeoffs; `handlePaste` may add to a takeoff). Read each site: if the mutation touches ONLY `measurements`, drop the PUT; if it also mutates takeoffs/pages, keep the PUT for that other part AND send the op (the op makes the measurement live; the PUT persists the rest — the version adoption from the ack keeps the subsequent PUT conflict-free since the save queue heals from `latestVersions`). Document the per-site decision in the report.
2. **Receiver adopts versions.** The `onMeasurementApplied` handler (the old L315-352 splice logic — kept from Task 4's mechanical swap) additionally does `noteProjectVersion(projectId, ev.version)` + `setProject(prev => prev ? { ...prev, version: ev.version } : prev)`. It must also ignore events for other pages (`ev.pageId !== pageId` → still adopt the version, skip the state splice — cross-page ops bump the shared project version).
3. **Backfill.** After `loadData(projectId, pageId)` completes AND on socket reconnect (subscribe to socket 'connect' — via `useCollaboration().socket`), call `joinCanvas(projectId, pageId)`; on `{ok:true}` replace this page's measurements in BOTH `page` state and `project.pages` and adopt the version. (Guard against clobbering an in-flight local drawing: skip the replace if the user is mid-draw — read how in-progress drawing state is held, e.g. current points buffer, and skip when non-empty; note the decision.)
4. **Undo/redo:** find how `useMeasurementHistory` applies undo/redo (read `src/hooks/useMeasurementHistory.ts` or its location) — if it routes through `updateMeasurement`/delete/add functions, ops flow automatically; if it sets state directly + saveProject, route its measurement mutations through the same op path. Document what you found.
5. `readOnly` client gating stays untouched. Region/scale/page-rename/etc. sites keep their full PUTs.
6. **Live non-measurement refresh (Nathan-requested addition): foreign scale changes and takeoff-list edits appear on an open canvas in real time.** Subscribe (raw socket, same effect area as `onMeasurementApplied`) to `entity-changed` events with `type === 'project'` and `id === projectId`; skip self-echo (`bySessionId === CLIENT_SESSION_ID`); **skip when `ev.version <= (project?.version ?? 0)`** — measurement ops adopt their version via ack/`measurement-applied` BEFORE the paired entity-changed arrives, so op traffic self-suppresses and only genuine full-PUT changes (scale, takeoffs, page renames) survive the check; debounce ~300ms; then re-run `loadData(projectId, pageId)` guarded by the same mid-draw skip as backfill (contract item 3). Net effect: a colleague re-calibrating the scale or adding/renaming a takeoff updates your open canvas within a second, while collaborative drawing causes zero extra reloads.

- [ ] **Step 1: Read the five sites + useMeasurementHistory + the drawing-in-progress state**; write the per-site plan in your report FIRST.
- [ ] **Step 2: Implement** per the contract.
- [ ] **Step 3: Verify** — `npm run test` + lint; then the canvas e2e gate: `npx playwright test canvas plan-set-readonly plan-set-sidebar-list collab-canvas-conflict collab-presence` (the drawing engine + read-only + conflict specs must all still pass — they now exercise the op path end-to-end since drawing persists via ops).
- [ ] **Step 4: Commit**

```bash
git add src/pages/CanvasView.tsx
git commit -m "feat(canvas): drawing persists via server ops — decoupled from project PUT, with backfill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Cursor throttle + Follow rename/merge + wording nits

**Files:**
- Modify: `src/components/PdfCanvas.tsx` (~L701-709), `src/context/CollaborationContext.tsx` (+test updates), `src/components/UserPresenceOverlay.tsx`, `src/components/FollowPill.tsx`, `src/pages/CanvasView.tsx` (checkbox + sidebar label), `src/pages/ProjectsPage.tsx` (toast wording)
- Test: update `CollaborationContext.test.tsx`, `UserPresenceOverlay.test.tsx`, `FollowPill.test.tsx`

**Interfaces / contract:**

1. **Cursor throttle** (PdfCanvas `handleMouseMove`): rAF + min-distance gate:

```ts
const cursorRafRef = useRef<number | null>(null);
const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
// in handleMouseMove, replacing the direct onCursorMove call:
if (onCursorMove && cursorRafRef.current === null) {
  cursorRafRef.current = requestAnimationFrame(() => {
    cursorRafRef.current = null;
    const last = lastCursorRef.current;
    if (!last || Math.abs(pos.x - last.x) + Math.abs(pos.y - last.y) >= 2) {
      lastCursorRef.current = { x: pos.x, y: pos.y };
      onCursorMove(pos.x, pos.y);
    }
  });
}
```
(Note `pos` must be captured per-frame — read the handler; use the latest position at rAF time by storing it in a ref the handler updates every event. Cancel the rAF in the unmount cleanup.)
2. **Follow rename + effect merge** (carried WS3 Important): rename `followedUserId`/`setFollowedUserId` → `followedSessionId`/`setFollowedSessionId` across the context type, provider, and all consumers (CanvasView:~L1778, UserPresenceOverlay:~L53, FollowPill, tests). Merge the two follow effects (~L161-182) into ONE effect keyed `[followedSessionId, sessions, location.pathname, navigate]` that does, in order: (a) if no followed session → clear ref, return; (b) **manual-nav check first**: if `location.pathname` differs from both the followed path and `followNavRef.current` → `setFollowedSessionId(null)`, clear ref, return; (c) then auto-nav: if followed path differs from pathname → set ref, navigate. This ordering fixes the batched-double-move race (the manual check runs before the ref is overwritten).
3. **Wording nits:** CanvasView:~L1770 `{session.location?.label || 'another page'}` → `{session.location?.pageId ? (session.location?.label || 'another page') : 'elsewhere in the app'}`; ProjectsPage:~L343 toast → `'Someone is currently working in this project — it cannot be deleted right now.'`; CollaborationContext `currentPageName` default: add the one-line comment above L60 explaining the brief 'Projects' label flash on canvas entry (behavior unchanged — cosmetic, documented).

- [ ] **Step 1: Rename + merge with tests updated first** (the existing follow tests assert behaviors that must survive the merge — run them, adjust names, add one new case: pathname change to an unrelated path clears follow even when the followed session simultaneously has a NEW path — simulate by firing session-updated and asserting via the merged effect that follow clears; this is the race regression test, writable in RTL because the merged effect makes ordering explicit).
- [ ] **Step 2: Cursor throttle + wording nits.**
- [ ] **Step 3: Run** — full `npm run test` + lint + `npx playwright test collab-follow collab-presence` (follow e2e must survive the rename).
- [ ] **Step 4: Commit**

```bash
git add src/components/PdfCanvas.tsx src/context/CollaborationContext.tsx src/context/CollaborationContext.test.tsx src/components/UserPresenceOverlay.tsx src/components/UserPresenceOverlay.test.tsx src/components/FollowPill.tsx src/components/FollowPill.test.tsx src/pages/CanvasView.tsx src/pages/ProjectsPage.tsx
git commit -m "feat(canvas): cursor throttling; followedSessionId rename + merged follow effects; wording nits

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Two-context canvas sync e2e (+screenshots), full verification, checklist, push

**Files:**
- Create: `e2e/collab-canvas-sync.spec.ts`
- Modify: `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md` (WS4 section)

- [ ] **Step 1: Full unit + lint green.**
- [ ] **Step 2: Write the spec** (fixtures: `openAuthedContext` from `e2e/fixtures/collab.ts`, `seedProjectWithPage`; drawing idiom from `e2e/canvas.spec.ts` `clickCanvas`; drag idiom from `e2e/plan-set-readonly.spec.ts` `dragVertex`). Scenarios:
  1. **Live draw sync:** A and B open the same canvas page. A calibrates scale + draws a length measurement (click-click-double-click per canvas.spec idiom). Assert B's measurement sidebar shows the measurement live (`measurement-row` testid) WITHOUT any reload. `bPage.screenshot({ path: 'test-results/ws4-live-draw-B.png' })`.
  2. **Server persistence without PUT:** reload B's page entirely (`bPage.reload()`); the measurement is still there (server applied the op — the old code would have lost it if A never full-saved; A performed no other action).
  3. **Backfill on late join:** fresh context C opens the page AFTER A drew; C sees the measurement immediately (canvas-join ack). Screenshot.
  4. **Drag sync:** B drags a vertex (dragVertex idiom); assert A's sidebar value changes (polling). Screenshot A.
  4b. **Scale/takeoff live refresh (Nathan-requested):** B recalibrates the page scale (or creates a takeoff via the sidebar — pick whichever the canvas UI makes deterministic; the canvas.spec calibration idiom exists); assert A's open canvas reflects it (scale readout or takeoff list entry) without reload, within a polling timeout. Screenshot.
  5. **Superseded rejection server-side:** use `seedProjectWithSupersededRevision`; connect a raw socket.io client (or simpler: assert via the existing plan-set-readonly spec still passing + a direct API check — if a raw-socket assertion is awkward in Playwright, note it and rely on the Task 3 unit coverage; do NOT contort the e2e).
- [ ] **Step 3: Run** — `npx playwright test collab-canvas-sync` isolated (3 stable runs), then FULL `npm run test:e2e`.
- [ ] **Step 4: Checklist** — tick all WS4 items (incl. the three carried items) with delivering hashes; plan path under the WS4 heading; do not touch other sections.
- [ ] **Step 5: Commit and push**

```bash
git add e2e/collab-canvas-sync.spec.ts docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md
git commit -m "test(canvas): two-context draw/drag/backfill sync proof; WS4 checklist complete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin testing
```

---

## Self-Review Notes

- **Spec §6 coverage:** membership+JWT ops (T3 — project-room membership per the carried finding), server-side op application + version-in-broadcast + PUT decoupling (T2/T3/T5), join backfill (T3/T5), throttling (T6 — cursors only; mid-drag ruled n/a since drags already emit only on end), superseded rejection server-side (T1/T2/T3), shim + dead-wire deletion (T3/T4), carried WS3 items (T6), two-context Playwright proof + screenshots (T7).
- **Ruled deviations:** mid-drag throttling n/a (nothing streams mid-drag today — building it would be new feature work the spec didn't intend); ops carry `clientTabId` (=CLIENT_SESSION_ID) for change-feed self-echo parity rather than the socket session id.
- **Type consistency:** `MeasurementOp`/`OpRejectedError` (T2) vs T3 handler rejections vs T4 client surface vs T5 usage — names and shapes match throughout; `noteProjectVersion` defined T4, used T4/T5.
- **Risk areas for reviewers:** T5 per-site PUT-vs-op decisions in the monolith (the report must document each); the T4 two-phase CanvasView touch (name-swap in T4, semantics in T5) — reviewers of each task get told the boundary; backfill-vs-mid-draw clobber guard (T5 contract item 3).
- Line numbers as of `da8b5b4` — locate by symbol when drifted.
