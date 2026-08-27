# Realtime Collaboration Upgrade — Design Spec

**Date:** 2026-08-23
**Status:** Approved by Nathan (brainstorming session 2026-08-21 → 2026-08-23)
**Progress tracking:** see [`2026-08-23-realtime-collaboration-checklist.md`](./2026-08-23-realtime-collaboration-checklist.md) — **read the "For AI agents" section below before doing any work on this project.**

---

## For AI agents: how to find your place

This upgrade ships as **five sequential workstreams** (WS1–WS5, defined in §9). Each workstream gets its own implementation plan and lands on the `testing` branch before the next begins. If you are picking this up in a fresh session:

1. **Read the checklist file** at `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md`. It is the single source of truth for what is done, in progress, or not started. Every item has a checkbox and completed items carry commit hashes.
2. **Never mark checklist items done without evidence** (tests passing, Playwright proof for canvas/UI interaction changes — see the memory rule "verify canvas changes with Playwright").
3. **Update the checklist in the same commit** as the work it describes, so the two can't drift.
4. Each workstream's plan lives in `docs/superpowers/plans/` (created via the `superpowers:writing-plans` skill when that workstream starts). If a plan exists for the current workstream, follow it; if not, write one from this spec first.
5. Constraints that always apply: no secure-context-only APIs (`crypto.randomUUID` etc. — use the `uuid` package; Nathan runs plain-HTTP LAN), SQLite `journal_mode = DELETE` must stay (Unraid FUSE), single-process deployment, and any data migration needs Nathan's supervision (none is expected in this project — see §8).

---

## 1. Goal and scope

Make the whole application collaborative in real time:

1. **Live refresh + edit awareness everywhere** — when any user saves anything, other users' screens update in real time; editors show who else is editing the same entity ("warn, but allow" — no hard locks); overwrites remain impossible via the existing version checks.
2. **Session-level presence** — the online-user list shows each *session* of a user (per device, auto-labeled from browser/OS), not one collapsed entry, so multi-computer users are fully visible.
3. **Spreadsheet editor rebuild** — Google-Sheets-style: full-fidelity styled display, live multi-user cell co-editing, autosave into the real file (no Save button), per-editing-session version snapshots. Fixes the current data-loss bug.
4. **Extras approved in scope:** fix the inert page-view guard, replace the destructive 409 hard-reload, harden canvas sync (auth, persistence, backfill, throttling), live dashboard + activity feed, and **app-wide Follow** (following a session navigates you wherever it goes).

Out of scope (explicit YAGNI): keystroke-level merging in form editors, offline editing/CRDTs, horizontal scaling (Redis adapter), a standalone notification system, chart/image/pivot *editing* in spreadsheets (they are preserved, not editable), xls-legacy editing, "Nathan is following you" visibility (Follow stays passive).

### Decisions made with Nathan (do not re-litigate)

| Question | Decision |
|---|---|
| Collab depth for form sections | Live refresh + edit awareness; **no** field-level merging |
| Spreadsheet collab | Live cell co-editing (FortuneSheet op hooks) |
| Spreadsheet fidelity | **Full fidelity display AND save** (Google-Sheets-like) |
| Spreadsheet save model | **Autosave to the real file** (~15s flush + on-last-leave); no Save button; one version snapshot per editing session + manual "Snapshot version" button |
| Edit guard behavior | Warn-but-allow banner; live form refresh; "Review & merge / Keep mine" on dirty conflict |
| Session labels | Auto device labels from user agent ("Windows · Chrome") |
| Follow | App-wide, attaches to a specific session, passive |
| Architecture | Approach A: authenticated event-bus over existing REST (not Yjs/CRDT, not SSE-minimal) |

---

## 2. Current state (findings from exploration, 2026-08-21)

Recorded so future agents don't re-explore. Line numbers are as of commit `f6e47ef`; verify before relying on them.

- **All socket logic** is one inline block: `server.ts:558-625`; server created at `server.ts:104-108`; presence store is a module-level object keyed by `socket.id` at `server.ts:92`.
- **No socket authentication.** No `io.use()` middleware; `userId` is client-asserted (`src/context/CollaborationContext.tsx:61,73`) and spoofable.
- **Rooms are URL pathnames** (`CollaborationContext.tsx:70,115`; `CanvasView.tsx:57` `pageRoom()`), so no project-level broadcast target exists.
- **Message types:** `join-page`, `cursor-move`, `measurement-update` (blind relay, no persistence/validation/membership check, `server.ts:599-601`), `update-user`, plus outbound `room-users`, `global-users` (full array to everyone on every change), `user-cursor`, `measurement-sync`.
- **Dead wire:** client emits `project-update` / listens `project-sync` (`CollaborationContext.tsx:95-97,142-144`; `CanvasView.tsx:354-358`) but the server has no handler — delete this path (WS4).
- **Presence dedup is client-side, triplicated:** `UserPresenceOverlay.tsx:12-25`, `CanvasView.tsx:2557-2570`, `PdfCanvas.tsx:2306-2317`. No heartbeat/TTL.
- **Canvas sync:** op-based over the wire, but persistence is a full-project PUT by the *sender only*; receivers apply ops to local state and never persist; no join-time backfill; cursor emits unthrottled (`PdfCanvas.tsx:701-709`).
- **Broken page-view guard:** `GET /api/pages/active` (`server.ts:377-386`) returns pathnames; `ProjectView.tsx:608` compares them to page UUIDs → never matches; polled every 5s (`ProjectView.tsx:335-344`).
- **Non-canvas sections:** REST + row `version` columns everywhere + 409 `version_conflict` + per-screen `load()` refetch. Editors catch `ConflictError` with a "changed elsewhere" toast. The only push-like mechanism is `ProjectConflictListener.tsx` doing a **full page reload** on project 409.
- **Change-feed seam:** `logActivity()` (`server/activity.ts:15-23`) is already called on most mutations — the natural place to hang broadcasts.
- **Spreadsheet editor bug (root cause):** `SpreadsheetEditor.tsx:107-138` builds saved xlsx from `sheet.celldata`, but FortuneSheet deletes `celldata` and moves truth into the `data` matrix on sheet activation (`@fortune-sheet/core` dist `index.js:66994-67004`) → **saves write empty worksheets for any touched tab**. Also: all styling lost on save (SheetJS community can't write styles), no concurrency check on `POST /api/files/:id/versions`, drafts are per-user (`drafts` table keyed `(userId, fileId)`).
- **Stack:** React 19 + plain useState/Context (no query lib), Express 4 + socket.io 4.8 in `server.ts`, better-sqlite3 (sync, `journal_mode=DELETE`), JWT auth, Vitest (server+ui projects, 700+ tests), Playwright e2e (`e2e/`, workers:1). `exceljs` already a dependency (used only by AIA export).

---

## 3. WS1 — Realtime core (server)

New module family `server/realtime/` replaces the inline socket block.

### Authentication
- `io.use()` handshake middleware verifies the same JWT as REST (`socket.handshake.auth.token`). Identity (`userId`, `name`, role) comes **only** from the verified token. Reject unauthenticated sockets.
- Client passes its token at connect; on auth failure/expiry the client reconnects after re-login. No token refresh protocol beyond that.

### Sessions & presence registry
- One socket connection = one **session**: `{ sessionId, userId, name, color, device, location, editing, lastActive }`.
- `sessionId`: server-generated (uuid package). `device`: parsed server-side from User-Agent → "Windows · Chrome", "iPad · Safari" style labels.
- `location` is structured: `{ path, projectId?, section?, pageId?, fileId? }` — client reports it on route change via a `set-location` event.
- Registry is in-memory, single-process, behind a small interface (`PresenceRegistry`) so a distributed adapter could be added later. **Do not add Redis now.**
- **Heartbeat:** server pings sessions every 25s; two missed beats → session swept, departure broadcast. (socket.io's own pingTimeout handles most cases; the sweep is a belt-and-braces TTL over `lastActive`.)

### Rooms
- `project:<projectId>` — joined by any client whose location is inside that project. Carrier for change events + project presence.
- `page:<pageId>` — canvas rooms (cursors, measurement ops). Replaces pathname rooms.
- `sheet:<fileId>` — spreadsheet collab sessions (WS5).
- Global channel for the online list. **Delta events, not full arrays:** `session-joined`, `session-left`, `session-updated` (location/editing/color changes). Clients maintain the list locally; a `sessions-snapshot` is sent once on connect.
- Server enforces room membership on every emit that targets a room.

### Compatibility during rollout
WS1 ships with a thin compat shim so the existing canvas relay and user list keep working (same event names re-emitted from the new core) until WS3/WS4 rewire the consumers. The shim is deleted in WS4.

---

## 4. WS2 — Change feed + live refresh + edit awareness

### Server: `broadcastChange(event)`
Called from the route layer after each successful mutation (co-located with existing `logActivity()` call sites):

```ts
{ kind: 'entity-changed',
  type: 'project'|'task'|'issue'|'rfi'|'punch'|'invoice'|'changeOrder'|'payment'
       |'aiaPayApp'|'aiaSov'|'file'|'note'|'customer'|'user'|'timeEntry'|...,
  id: string, projectId?: string, version?: number,
  action: 'created'|'updated'|'deleted',
  byUserId: string, bySessionId?: string }
```

- Emitted into `project:<projectId>` when project-scoped; globally otherwise (customers, users, global documents).
- **No entity payload** — identity + version only. Data always refetched over REST so permissions stay enforced in one place.
- `bySessionId` comes from an `X-Session-Id` header the client attaches to REST calls (its socket sessionId), enabling self-echo suppression.

### Client: `useLiveQuery(load, filter)`
Wraps the existing per-screen `load()` pattern:
- Runs `load()` on mount; subscribes with filter `{types, projectId?, id?}`; re-runs `load()` on match.
- **Self-echo suppression** (ignore events with own `bySessionId`), **debounce** (~300ms coalescing), **version skip** (event.version ≤ held version → skip), **reconnect catch-up** (refetch once on socket reconnect).

Screens converted (each is a checklist item): tasks (global + project), issues, RFIs, punch, billing tabs (invoices, pay apps, SOV, change orders, payments, summary), documents (global + project), project list, project sections overview/cards, notes, customers, users list, time keeping. (Dashboard and activity feed convert in WS3, where their live behavior is specified.)

### Edit awareness
- Editors declare `editing: {type, id}` on their session (cleared on close/death — presence-based, **no lock table, nothing persisted**).
- Shared `<EditPresenceBanner>` in every entity editor: "«name» is editing this («device»)". Multiple editors listed. List rows get a "being edited" chip.
- Open-editor behavior on incoming `entity-changed` for the open entity:
  - **Pristine form** → silently reload to new version.
  - **Dirty form** → keep the user's typing; banner becomes "«name» saved changes while you were editing" with **Review & merge** (reload fresh, user re-applies) and **Keep mine** (adopt new version number, save over deliberately). Existing 409 toast remains the final backstop.
- Editors covered: TaskEditor, IssueEditor, RfiEditor, PunchItemEditor, InvoiceEditor, ChangeOrderEditor, AiaPayAppEditor, AiaScheduleOfValues, ProjectSettings, proposal editor, notes.

### 409 hard-reload replacement
Delete the full-page reload in `ProjectConflictListener`. On project 409: refetch project via existing `latestVersions` healing, dispatch in-place `project-refreshed`; mounted live screens re-render naturally. Canvas-specific handling in WS4.

### Accepted deviations & risks (WS1-WS2 as-built)
- `broadcastChange` uses a global `io.emit` for `entity-changed` rather than always scoping to `project:<projectId>` — non-admin sockets can receive billing-entity change metadata (ids/types/versions only, never payloads); REST refetches stay permission-checked, so no data actually leaks.
- `bySessionId` is a client-chosen per-tab id, spoofable on the trusted LAN — it's used only for self-echo suppression, never as a security boundary.
- `sessionId` is `socket.id`, so it changes on every reconnect (edit-presence and Follow both re-key naturally, but any assumption of a stable per-tab id across reconnects would be wrong).
- `ProjectSettings` and the proposal editor share the same `{type: 'project'}` editing-presence namespace, so editing one shows as "editing this too" while someone edits the other — an accepted cross-show, not a bug.

---

## 5. WS3 — Presence UI: sessions, Follow, page guard, live dashboard

- **Online users list** (rebuilt `UserPresenceOverlay` + canvas sidebar list): one row per user, expandable to sessions with device label + human-readable location (project name + section / page name). Own other sessions visible. Delete all three `collapseSessions()` copies.
- **App-wide Follow:** attaches to a **session**. Followed session's `location` change → follower navigates to same route; on canvas the existing cursor/viewport follow continues to work. Persistent "Following «name» («device») — Stop" pill; stops on manual navigation, Stop, or followed-session disconnect. Passive (followed user not notified).
- **Page-view guard fixed:** delete `/api/pages/active` + 5s poll + broken comparison. Live session locations carry real `pageId`s → viewer avatars on the project page list, working rename guard, "being edited" chip on spreadsheet document rows (consumed in WS5).
- **Live dashboard + activity:** dashboard cards and activity feed on `useLiveQuery`; activity events stream in live (de-facto notification stream; no separate notification system).

---

## 6. WS4 — Canvas hardening

- **Auth + membership:** measurement ops accepted only from sockets joined to that `page:<id>` room; identity from JWT. Delete the dead `project-update`/`project-sync` wire and the WS1 compat shim.
- **Server-side op application:** each `add`/`update`/`delete` measurement op is applied to the `measurements` table as it's relayed, project version bumped, new version included in the broadcast; all participants adopt it. Drawing no longer routes through the full-project PUT (which stays for page setup/takeoffs/calibration). This removes the sender-only-persists / receiver-never-persists asymmetry and the 409 dance while drawing.
- **Join-time backfill:** `page:<id>` join ack returns current measurement set + version.
- **Ordering:** server applies ops in arrival order (better-sqlite3 sync = naturally serialized); last-writer-wins per measurement (matches current semantics).
- **Throttling:** cursor emits rAF + min-distance gated (~30/s cap); mid-drag measurement updates throttled; final drag-end op always sent.
- **Read-only enforcement server-side too:** reject ops targeting superseded plan-set pages.
- **Verification rule:** two-browser-context Playwright tests with real click-drag + screenshots (standing memory rule).

---

## 7. WS5 — Spreadsheet editor rebuild

### Fidelity in (`sheetBridge` module, exceljs-based; SheetJS leaves the editor path)
xlsx → FortuneSheet with styles: fonts (family/size/bold/italic/color), fills, borders, alignment + wrap, number formats (SSF-rendered), merges, column widths/row heights, frozen panes; formulas as formulas. Non-representable content (charts, images, pivots, conditional formatting, data validation) is not rendered but **preserved** through the save path.

### Live collab session (server-held, per file)
- Opening a sheet joins `sheet:<fileId>`. First joiner → server loads working copy (FortuneSheet JSON + original workbook bytes). Later joiners receive the working copy.
- Editors send FortuneSheet ops (`onOp`); server applies to working copy in arrival order, rebroadcasts (`applyOp`). Cell-level presence: colored selection boxes with names from the session registry.
- **Journal:** every applied op is journaled to disk immediately (append-style). Server restart replays journal → nothing typed is ever lost.

### Autosave to the real file (no Save button)
- Server flushes working copy into the **live xlsx** via exceljs patch: changed values/formulas/styles written onto the original bytes; structural ops (row/col/sheet insert-delete-rename) applied as exceljs operations; everything else survives untouched.
- Flush cadence: every ~15s while active, always when the last participant leaves, and on server shutdown; journal replay completes interrupted flushes.
- **Versioning:** one immutable version snapshot per editing session — when the last participant leaves, pre-session bytes are archived via the existing version chain (`saveNewVersion` machinery). Plus a manual "Snapshot version" button. No per-save version spam. No "close without saving" — restore-a-version is the escape hatch.
- Replaces per-user IndexedDB/draft persistence for spreadsheets (working copy is shared per file). Storage for journal/working copy: ride in `drafts` under a system marker **or** a small additive table — decide at plan time; additive either way.
- Documents list shows "being edited" chip (from WS3 presence) while a session is live.

### Scope guardrails
Editable: values, formulas, the style set above, merges, row/col/sheet add-delete-rename, widths/heights. Preserved read-only: charts, images, pivots, conditional formatting, validation. Rich text and hyperlinks are NOT preserved — they're flattened to plain text on import (flagged in the same import-warnings mechanism as images/validation). csv keeps the plain path; xls legacy → "convert to xlsx first" message.

### Known windows & limits (final-fix-wave note, 2026-08-26)
- **Residual fold race:** peer B's debounced state-sync can fold the op journal at the exact moment peer A has an op in flight that the server hasn't recorded yet — A's op is then absent from B's authoritative state. This heals itself via A's own next debounced sync (≤2s) or its unmount-flush push; real data loss requires A to hard-crash within that ~2s window. Accepted as a documented residual risk, not fixed — the alternative (a full op-vector-clock reconciliation) is out of scope for this rebuild.
- **Size ceilings:** a session's folded state over ~25MB makes autosave fail for that file (client shows a throttled toast, no retry loop); an individual op batch over ~1MB is rejected server-side but still applied to the sender's own local document, so peers diverge until the next rejoin re-hydrates them.
- **Documents-page staleness:** the Documents list's download/preview of a live-being-edited file lags the actual working copy by up to (flush interval + debounce), i.e. up to ~17s behind the editor during an active session.

---

## 8. Migrations & operational notes

- **No data-transforming migration expected.** Everything builds on existing `version` columns, the files version chain, and (possibly) one small **additive** table for sheet journals. If any migration becomes necessary it must be additive, and Nathan must be flagged before any pull that runs one (standing rule).
- Single-process, in-memory presence. Plain-HTTP LAN: **no secure-context APIs** (use `uuid` package).
- SQLite `journal_mode = DELETE` stays.

## 9. Rollout order & testing

Workstreams ship sequentially to `testing`, app fully usable throughout:

| WS | Content | Depends on |
|---|---|---|
| WS1 | Realtime core: auth, sessions, rooms, presence registry, heartbeat, compat shim | — |
| WS2 | Change feed, `useLiveQuery`, section conversions, edit awareness, 409-reload replacement | WS1 |
| WS3 | Session list UI, app-wide Follow, page guard fix, live dashboard/activity | WS1 (WS2 for dashboard queries) |
| WS4 | Canvas hardening: op persistence, backfill, throttling, shim removal | WS1 |
| WS5 | Spreadsheet rebuild: fidelity bridge, collab session, autosave, versioning | WS1, WS3 (chip), largest — last |

**Testing per workstream:**
- WS1: Vitest integration with real socket.io clients — auth rejection, membership enforcement, presence lifecycle, heartbeat sweep, delta events.
- WS2: RTL for `useLiveQuery` (event refetch, self-echo, debounce, version skip, reconnect) and banner states against mocked socket; server tests for `broadcastChange` fan-out.
- WS3: RTL for session grouping/labels; Playwright for Follow navigation.
- WS4: two-browser-context Playwright click-drag sync proof; server tests for op persistence, backfill, superseded-page rejection.
- WS5: round-trip fidelity tests (styled fixture workbook → edit one cell → flush → byte-inspect with exceljs proving styles/charts/merges survive), journal-replay-after-kill test, two-context Playwright collab test.
- All existing tests (700+) keep passing; e2e suite gains a collab group. Canvas/UI interaction changes are always proven with real Playwright interaction per the standing memory rule.
