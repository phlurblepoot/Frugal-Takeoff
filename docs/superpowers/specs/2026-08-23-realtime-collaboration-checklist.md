# Realtime Collaboration Upgrade — Progress Checklist

**Spec:** [`2026-08-23-realtime-collaboration-design.md`](./2026-08-23-realtime-collaboration-design.md) — read its "For AI agents" section first.

## How to use this file (for AI agents)

- This file is the **single source of truth** for progress on the realtime collaboration upgrade. Check it at the start of any session touching this project.
- Work top-to-bottom: workstreams are sequential (WS1 → WS5). Within a workstream, items may be reordered by its implementation plan.
- Mark an item `[x]` **only with evidence** (tests passing; Playwright interaction proof for canvas/UI changes), and append the commit hash: `[x] … (`abc1234`)`.
- Update this file **in the same commit** as the work it describes.
- If a workstream's implementation plan exists in `docs/superpowers/plans/`, note its path under the workstream heading and follow it.
- Statuses: `[ ]` not started · `[~]` in progress (note what remains) · `[x]` done with hash.

---

## WS1 — Realtime core

Plan: docs/superpowers/plans/2026-08-23-ws1-realtime-core.md

- [x] `server/realtime/` module scaffolding; socket logic moved out of `server.ts` (`1749e54`, `36756d5`)
- [x] JWT handshake auth (`io.use`), identity from token only; unauthenticated sockets rejected (`ab5f135`)
- [x] Session model (`sessionId` = socket.id, server-assigned; server-side device label from User-Agent) (`00e607b`, `ab5f135`, `e10763e`)
- [x] `PresenceRegistry` (in-memory, interface-wrapped) + structured `location` via `set-location` (`1749e54`, `8b92e87`)
- [x] Heartbeat ping (25s) + stale-session sweep + departure broadcast (`bde55c0`)
- [x] Resource rooms: `project:<id>`, `page:<id>`, `sheet:<fileId>`; membership enforced on emit (`8b92e87`)
- [x] Global delta presence events (`sessions-snapshot`, `session-joined/left/updated`) replacing full-array `global-users` (`8b92e87`, `36756d5`)
- [x] Client: `CollaborationContext` connects with JWT, reports location, consumes deltas (`5d1b36a`, `10efe01`)
- [x] Compat shim: legacy canvas relay + user-list events still work (removed in WS4) (`bbb49b4`)
- [x] Vitest integration tests: auth rejection, membership, presence lifecycle, heartbeat sweep, deltas (`ab5f135`, `8b92e87`, `bde55c0`, `bbb49b4`)
- [x] Full existing test suite passing (`10efe01`)

## WS2 — Change feed + live refresh + edit awareness

Plan: docs/superpowers/plans/2026-08-24-ws2-change-feed-live-refresh.md

- [x] `broadcastChange()` wired at all mutation route sites (co-located with `logActivity`) (`76c57b9`, `5826e1c`, `12b60e3`, `4f85bb9`, `a40cef8`)
- [x] `X-Session-Id` header on client REST calls for self-echo suppression (`7ef8fcd`)
- [x] `useLiveQuery` hook (refetch-on-event, self-echo skip, ~300ms debounce, version skip, reconnect catch-up) + RTL tests (`7ef8fcd`)
- [x] Section conversions to `useLiveQuery`:
  - [x] Tasks (global list + project tab + dashboard cards) (`cd88682`)
  - [x] Issues (`cd88682`)
  - [x] RFIs (`cd88682`)
  - [x] Punch (`cd88682`)
  - [x] Billing: invoices / pay apps / SOV / change orders / payments / summary (`36f5cdc`)
  - [x] Documents (global + project) (`36f5cdc`)
  - [x] Project list (`36f5cdc`)
  - [x] Project sections overview / project cards (`36f5cdc`)
  - [x] Notes (`cd88682`)
  - [x] Customers (`36f5cdc`)
  - [x] Users list, time keeping (`36f5cdc`)
  - _(Dashboard + activity feed convert in WS3)_
- [x] `editing` presence declared by all entity editors (Task/Issue/Rfi/Punch/Invoice/ChangeOrder/AiaPayApp/AiaSov/ProjectSettings/proposal/notes) (`f04c11c`, `71571af`, `29547c9`)
- [x] `<EditPresenceBanner>` shared component + list-row "being edited" chips (`f04c11c`, `71571af`, `29547c9`)
- [x] Open-editor live refresh: pristine→silent reload; dirty→Review & merge / Keep mine (`f04c11c`, `71571af`, `29547c9`)
- [x] 409 hard-reload replaced with in-place project refresh (`ProjectConflictListener` reload deleted) (`549f7a6`)
- [x] Carried from WS1 final review: normalize/validate the `verifyToken` payload at the boundary (`server.ts` — a legacy token missing `role` currently becomes the string `"undefined"`; WS2 gates on role) (`76c57b9`)
- [x] Carried from WS1: `X-Session-Id` is a stable per-tab client id (`CLIENT_SESSION_ID`), decoupled from the reconnect-sensitive socket id (`7ef8fcd`)
- [x] Full test suite passing (unit: 1082/1082; e2e: 49/49 incl. two-context `e2e/collab-live-refresh.spec.ts`)

## WS3 — Presence UI: sessions, Follow, page guard, live dashboard

Plan: docs/superpowers/plans/2026-08-25-ws3-presence-ui.md

- [x] Online list rebuilt: per-user rows expandable to per-session (device label + readable location); own sessions visible (`49e72f6`, `41465c3`)
- [x] Triplicated `collapseSessions()` deleted (UserPresenceOverlay, CanvasView, PdfCanvas) (`41465c3`, `fe0651e`)
- [x] App-wide Follow (session-scoped): auto-navigation, Stop pill, stops on manual nav/disconnect (`9434997`, `cdb6cdb`; e2e proof `e2e/collab-follow.spec.ts`). Ruled deviation: no viewport/cursor-follow on canvas was built — it never existed pre-WS3, and the spec's "continues to work" clause referred to a behavior exploration that was disproved (see plan's Global Constraints / task-9 self-review notes)
- [x] Page-view guard: `/api/pages/active` + 5s poll deleted; live viewer avatars on page list; rename guard actually works (`db24c3e`)
- [x] Live dashboard cards + streaming activity feed (`a14b585`)
- [x] Playwright: Follow navigation proof (`e2e/collab-follow.spec.ts`); RTL: session grouping/labels (`41465c3`)
- [x] Full test suite passing (unit: 1131/1131; e2e: 51/51 incl. two-context `e2e/collab-follow.spec.ts`)

## WS4 — Canvas hardening

Plan: docs/superpowers/plans/2026-08-25-ws4-canvas-hardening.md

- [x] Measurement ops require joined `page:<id>` room + JWT identity (`990cfe1`)
- [x] Server-side op application to `measurements` table + version bump included in broadcast; drawing decoupled from full-project PUT (`b4ae81b`, `ec5855a`, `990cfe1`, `50bb329`)
- [x] Join-time backfill (measurement set + version in join ack) (`990cfe1`, `50bb329`)
- [x] Cursor + mid-drag throttling (rAF + min-distance; drag-end always sent) (`d21163d`)
- [x] Server rejects ops on superseded plan-set pages (`f761027`, `0ced746`, `b4ae81b`)
- [x] Dead `project-update`/`project-sync` wire deleted; WS1 compat shim removed (`990cfe1`, `de1584e`)
- [x] Carried from WS1 final review: cross-page measurement emits (CanvasView emits to a `pageRoom(sourcePageId)` the sender may not be in) are silently dropped by the WS1 membership check — WS4's server-side op application must accept ops for any page in a project the sender's `project:` room covers (`990cfe1`)
- [x] Carried from WS3 final review: rename `followedUserId` → `followedSessionId` AND merge the two follow effects in `CollaborationContext.tsx:157-182` (manual-nav check BEFORE updating `followNavRef`) — fixes a fails-safe race where a followed session moving twice in one batched commit silently drops the follow (`d21163d`)
- [x] Carried from WS3 (wording nits, fix opportunistically): CanvasView sidebar shows "another page" for label-less locations (use describeLocation or "elsewhere in the app"); ProjectsPage delete-guard toast still says "has pages currently being viewed" though it now fires project-wide; canvas entry briefly broadcasts label "Projects" before setPageName lands (`d21163d`)
- [x] Two-browser-context Playwright click-drag sync proof (+ screenshots) — `e2e/collab-canvas-sync.spec.ts` (scenarios 1-4b: live draw sync, persistence without PUT, late-join backfill, drag sync, foreign scale/takeoff live-refresh); scenario 5 (superseded rejection) proven via a raw socket.io-client connection in the same spec, backed by unit coverage in `server/realtime/registerRealtime.canvas.test.ts` case 4
- [x] Full test suite passing (unit: 1161/1161; e2e: 54/54 incl. two-context `e2e/collab-canvas-sync.spec.ts`)

## WS5 — Spreadsheet editor rebuild

Plan: docs/superpowers/plans/2026-08-26-ws5-spreadsheet-rebuild.md

- [x] `sheetBridge` import: exceljs → FortuneSheet with styles/merges/widths/formats/frozen panes/formulas (SheetJS removed from editor path) (`cb28c3a`, `df7a0cc`, `f643f13`)
- [x] Server collab session per `sheet:<fileId>`: working copy, op apply + rebroadcast, late-joiner snapshot (`95a676a`, `dd05f3d`)
- [x] Cell-level presence (colored selections + names) (`dd05f3d`, `d3835fe`)
- [x] Op journal to disk + replay-on-restart (`95a676a`; replay proof `server/realtime/registerRealtime.sheets.test.ts`, this task's commit)
- [x] Autosave flush (~15s active / last-leave / shutdown) via exceljs patch onto original bytes; non-representable content preserved (`5af1a10`, `d193676`, `851315d`, `dd05f3d`)
- [x] Structural ops (row/col/sheet add-delete-rename) via exceljs (`df7a0cc`)
- [x] Per-editing-session version snapshot (pre-session bytes archived) + manual "Snapshot version" button (`5af1a10`, `d193676`, `851315d`, `dd05f3d`)
- [x] Journal/working-copy storage decided (drafts marker vs small additive table) and implemented — two additive tables (`sheet_sessions` + `sheet_ops`, migration 26) (`95a676a`)
- [x] Per-user IndexedDB/draft path replaced for spreadsheets; Documents "being edited" chip wired (`d3835fe`, `ed8adc2`)
- [x] csv plain path kept; xls → "convert to xlsx" message (`d3835fe`)
- [x] Round-trip fidelity tests (styled fixture; charts/images/merges survive single-cell edit) (`cb28c3a`, `df7a0cc`, `f643f13`; this task's commit fixed a live-edit round-trip regression these e2e specs caught — see below)
- [x] Journal-replay-after-kill test — `server/realtime/registerRealtime.sheets.test.ts` "journal survives a simulated server restart" (this task's commit)
- [x] Two-context Playwright collab test — `e2e/collab-sheets.spec.ts` (this task's commit)
- [x] Full test suite passing (unit: 1247/1247; e2e: 60/60 incl. new `e2e/sheets-editor.spec.ts` + `e2e/collab-sheets.spec.ts`, each run 3x stable) (this task's commit)

## Post-project

- [ ] Manual multi-device smoke with Nathan (two computers + tablet)
- [ ] Changelog entry + version bump
- [ ] Memory file updated (`phaseN-…-complete.md` style) per workstream
