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
- [x] Session model (`sessionId` via uuid, server-side device label from User-Agent) (`00e607b`, `ab5f135`)
- [x] `PresenceRegistry` (in-memory, interface-wrapped) + structured `location` via `set-location` (`1749e54`, `8b92e87`)
- [x] Heartbeat ping (25s) + stale-session sweep + departure broadcast (`bde55c0`)
- [x] Resource rooms: `project:<id>`, `page:<id>`, `sheet:<fileId>`; membership enforced on emit (`8b92e87`)
- [x] Global delta presence events (`sessions-snapshot`, `session-joined/left/updated`) replacing full-array `global-users` (`8b92e87`, `36756d5`)
- [x] Client: `CollaborationContext` connects with JWT, reports location, consumes deltas (`5d1b36a`, `10efe01`)
- [x] Compat shim: legacy canvas relay + user-list events still work (removed in WS4) (`bbb49b4`)
- [x] Vitest integration tests: auth rejection, membership, presence lifecycle, heartbeat sweep, deltas (`ab5f135`, `8b92e87`, `bde55c0`, `bbb49b4`)
- [x] Full existing test suite passing (`10efe01`)

## WS2 — Change feed + live refresh + edit awareness

Plan: _not yet written_

- [ ] `broadcastChange()` wired at all mutation route sites (co-located with `logActivity`)
- [ ] `X-Session-Id` header on client REST calls for self-echo suppression
- [ ] `useLiveQuery` hook (refetch-on-event, self-echo skip, ~300ms debounce, version skip, reconnect catch-up) + RTL tests
- [ ] Section conversions to `useLiveQuery`:
  - [ ] Tasks (global list + project tab + dashboard cards)
  - [ ] Issues
  - [ ] RFIs
  - [ ] Punch
  - [ ] Billing: invoices / pay apps / SOV / change orders / payments / summary
  - [ ] Documents (global + project)
  - [ ] Project list
  - [ ] Project sections overview / project cards
  - [ ] Notes
  - [ ] Customers
  - [ ] Users list, time keeping
  - _(Dashboard + activity feed convert in WS3)_
- [ ] `editing` presence declared by all entity editors (Task/Issue/Rfi/Punch/Invoice/ChangeOrder/AiaPayApp/AiaSov/ProjectSettings/proposal/notes)
- [ ] `<EditPresenceBanner>` shared component + list-row "being edited" chips
- [ ] Open-editor live refresh: pristine→silent reload; dirty→Review & merge / Keep mine
- [ ] 409 hard-reload replaced with in-place project refresh (`ProjectConflictListener` reload deleted)
- [ ] Full test suite passing

## WS3 — Presence UI: sessions, Follow, page guard, live dashboard

Plan: _not yet written_

- [ ] Online list rebuilt: per-user rows expandable to per-session (device label + readable location); own sessions visible
- [ ] Triplicated `collapseSessions()` deleted (UserPresenceOverlay, CanvasView, PdfCanvas)
- [ ] App-wide Follow (session-scoped): auto-navigation, Stop pill, stops on manual nav/disconnect; canvas cursor-follow still works
- [ ] Page-view guard: `/api/pages/active` + 5s poll deleted; live viewer avatars on page list; rename guard actually works
- [ ] Live dashboard cards + streaming activity feed
- [ ] Playwright: Follow navigation proof; RTL: session grouping/labels
- [ ] Full test suite passing

## WS4 — Canvas hardening

Plan: _not yet written_

- [ ] Measurement ops require joined `page:<id>` room + JWT identity
- [ ] Server-side op application to `measurements` table + version bump included in broadcast; drawing decoupled from full-project PUT
- [ ] Join-time backfill (measurement set + version in join ack)
- [ ] Cursor + mid-drag throttling (rAF + min-distance; drag-end always sent)
- [ ] Server rejects ops on superseded plan-set pages
- [ ] Dead `project-update`/`project-sync` wire deleted; WS1 compat shim removed
- [ ] Two-browser-context Playwright click-drag sync proof (+ screenshots)
- [ ] Full test suite passing

## WS5 — Spreadsheet editor rebuild

Plan: _not yet written_

- [ ] `sheetBridge` import: exceljs → FortuneSheet with styles/merges/widths/formats/frozen panes/formulas (SheetJS removed from editor path)
- [ ] Server collab session per `sheet:<fileId>`: working copy, op apply + rebroadcast, late-joiner snapshot
- [ ] Cell-level presence (colored selections + names)
- [ ] Op journal to disk + replay-on-restart
- [ ] Autosave flush (~15s active / last-leave / shutdown) via exceljs patch onto original bytes; non-representable content preserved
- [ ] Structural ops (row/col/sheet add-delete-rename) via exceljs
- [ ] Per-editing-session version snapshot (pre-session bytes archived) + manual "Snapshot version" button
- [ ] Journal/working-copy storage decided (drafts marker vs small additive table) and implemented
- [ ] Per-user IndexedDB/draft path replaced for spreadsheets; Documents "being edited" chip wired
- [ ] csv plain path kept; xls → "convert to xlsx" message
- [ ] Round-trip fidelity tests (styled fixture; charts/images/merges survive single-cell edit)
- [ ] Journal-replay-after-kill test
- [ ] Two-context Playwright collab test
- [ ] Full test suite passing

## Post-project

- [ ] Manual multi-device smoke with Nathan (two computers + tablet)
- [ ] Changelog entry + version bump
- [ ] Memory file updated (`phaseN-…-complete.md` style) per workstream
