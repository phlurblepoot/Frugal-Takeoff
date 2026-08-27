# WS5 — Spreadsheet Editor Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The spreadsheet editor becomes Google-Sheets-like: full-fidelity styled display, live multi-user cell co-editing with cell presence, autosave into the real file (no Save button), and per-editing-session version snapshots — killing the celldata data-loss bug and the formatting destruction.

**Architecture:** A new isomorphic `sheetBridge` (exceljs ⇄ FortuneSheet JSON) replaces SheetJS in the editor path: import carries styles/merges/widths/formats/frozen panes; export PATCHES the original workbook (grid rebuilt per sheet from FortuneSheet state — structure included — while workbook/sheet-level artifacts like charts and images survive untouched). Live collab treats FortuneSheet ops as **opaque**: a client's `onOp` batch is journaled to SQLite and relayed verbatim to peers who `applyOp` it (never interpreted server-side — the op format is internal immer patches); a debounced authoritative **full-state sync** from editing clients keeps the server's working copy fresh, and late joiners hydrate from state + replay the journaled op tail client-side. The server flushes the working copy into the real xlsx via the bridge (~15s while dirty, on last-leave, on shutdown); the first flush of an editing session archives the pre-session bytes through the existing version chain (= one snapshot per session), and a manual "Snapshot version" button forces one. All socket handlers mirror WS4's acked-op/join-snapshot/membership/error-enum pattern on the already-existing (currently dead) `sheet:<fileId>` room.

**Tech Stack:** exceljs 4.4 (already a dep, already used client-side in aiaExcel.ts — isomorphic OK), @fortune-sheet/react 1.0.4 (`onOp`/`applyOp`/`addPresences`/`removePresences`/hooks per its d.ts), socket.io acks, better-sqlite3 (2 new ADDITIVE tables, migration 26), Vitest + the WS1 realtime test harness, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-realtime-collaboration-design.md` (§7 = WS5; §8 pre-authorizes one small additive migration). Progress: `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md` — tick WS5 items with hashes in the same commit as the work.

## Global Constraints

- **Migration 26 is ADDITIVE only** (two new tables; nothing existing altered). Per standing rule, Nathan must be told before the container pull that runs it — the final task's report reminds the controller.
- No secure-context browser APIs (`uuid` package). SQLite `journal_mode = DELETE` stays. Single-process; in-memory session registry mirrors WS1's presence pattern with SQLite persistence for crash safety.
- **No per-op DB reads at keystroke rate (WS4-carried):** the working copy lives in memory; SQLite writes are appends (op batches) + debounced state saves; file reads happen once per session start.
- **FortuneSheet ops are OPAQUE** — relay and journal them verbatim; NEVER parse `op.path` semantics server-side (internal immer-patch format; only the client's own `applyOp` may consume them). The server's knowledge of content comes exclusively from full-state syncs.
- Socket handlers mirror WS4's pattern exactly: ack `{ok:true,...}|{ok:false,error}`, membership via `socket.rooms.has(sheetRoom(fileId))`, try/catch → `'internal'`, error enum documented in one comment block: `not_in_sheet | file_not_found | not_spreadsheet | invalid_request | no_db | internal`.
- All existing tests keep passing (`npm run test` 1176+, lint clean, `npm run test:e2e` 58+). Commit per task on `testing`; push only in the final task; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **The existing `drafts` table is untouched** (it stays per-user for the PDF editor). The editor's per-user server draft usage for fileId-backed sheets is REMOVED (replaced by the shared working copy); the IndexedDB tab persistence stays for ad-hoc (no-fileId) tabs only.
- Scope guardrails (spec §7): editable = values, formulas, fonts/fills/borders/alignment/wrap, number formats, merges, row/col/sheet add-delete-rename, widths/heights, frozen panes. Preserved-not-editable = charts, images, pivots, conditional formatting, validation (with the documented limitation that cell-anchored artifacts don't shift when rows/cols move — grid-rebuild patching, no splice). csv keeps today's plain value path (openable, editable values, Download — NO collab session, NO autosave). xls (legacy) → read-only message "Convert to xlsx first (open in Excel and save as .xlsx)".
- `DocumentViewerModal`'s read-only SheetJS peek is NOT the editor path — it stays as-is (spec: "SheetJS leaves the editor path").

## File Structure

| File | Responsibility |
|---|---|
| Create `src/utils/sheetBridge.ts` (+tests ×2) | isomorphic exceljs⇄FortuneSheet: `workbookToFortuneSheets`, `patchWorkbookFromFortuneSheets` |
| Modify `server/migrationList.ts` | migration 26: `sheet_sessions` + `sheet_ops` (additive) |
| Create `server/realtime/sheetSessions.ts` (+test) | working-copy registry: state, op journal, dirty/flush bookkeeping, SQLite persistence, crash recovery |
| Create `server/realtime/sheetFlush.ts` (+test) | flush engine: bridge-patch onto original bytes, first-flush session snapshot via `saveNewVersion`, manual snapshot |
| Modify `server/realtime/registerRealtime.ts` (+test) | `sheet-join` / `sheet-op` / `sheet-state-sync` / `sheet-snapshot` / `sheet-presence` handlers; leave-flush wiring |
| Modify `server.ts` | SIGTERM/SIGINT flush hook (new, small) |
| Modify `src/context/CollaborationContext.tsx` (+tests) | `joinSheet` / `sendSheetOp` / `sendSheetState` / `requestSheetSnapshot` / `sendSheetPresence` / `onSheetEvent` |
| Rewrite guts of `src/pages/SpreadsheetEditor.tsx` | bridge import path, collab session mode, autosave status UI, Snapshot button, csv/xls handling |
| Create `src/components/FileViewerDots.tsx` (+test); modify `src/pages/documents/DocumentsPage.tsx` | "being edited" dots on document rows from sessions' `location.fileId` |
| Create `e2e/sheets-editor.spec.ts`, `e2e/collab-sheets.spec.ts` | single-user fidelity/autosave + two-context collab proofs |

---

### Task 1: sheetBridge — import (exceljs → FortuneSheet)

**Files:**
- Create: `src/utils/sheetBridge.ts`
- Test: `src/utils/sheetBridge.import.test.ts`

**Interfaces:**
- Consumes: `exceljs` (`Workbook`, `Worksheet`, `Cell.style` {font, fill, border, alignment, numFmt}, `worksheet.views` frozen state, `worksheet.columns[].width`, `row.height`, merges — CONFIRM the merge read-back API first: check `worksheet.model.merges` vs iterating `worksheet._merges` in the actual exceljs source/d.ts and use the public-most option; document the finding in a comment). FortuneSheet `Sheet`/`Cell` shapes from `@fortune-sheet/core` d.ts: `celldata: {r,c,v: Cell}[]`, `config: {merge, rowlen, columnlen, borderInfo}`, `frozen`, cell fields `v/m/f/ct/bl/it/fs/ff/fc/bg/ht/vt/tb/mc`.
- Produces:

```ts
// Both functions are ISOMORPHIC (no DOM, no Node-only APIs) — used by the
// client editor (display) and the server flush engine (export).
export interface BridgeResult { sheets: FortuneSheetData[]; warnings: string[] }
// FortuneSheetData = the @fortune-sheet Sheet shape (re-export the type or a
// structural subset — decide by importing types from @fortune-sheet/core if
// clean, else declare the structural subset locally and document why).

export async function workbookToFortuneSheets(xlsxBytes: ArrayBuffer | Buffer): Promise<BridgeResult>;
```

Mapping contract (each line is at least one test assertion):
- values (string/number/boolean/date→serial-or-ISO — read what exceljs yields and normalize; document), formulas → `f: '=' + formula` with cached `v` from result
- font: bold→`bl:1`, italic→`it:1`, size→`fs`, name→`ff`, color argb→`fc:'#rrggbb'`
- fill (solid pattern) → `bg:'#rrggbb'`
- alignment: horizontal→`ht` (0 center/1 left/2 right per FortuneSheet convention — verify against core d.ts comments/source and encode the verified mapping), vertical→`vt`, wrapText→`tb:'2'`
- numFmt → `ct: {fa: numFmt, t: 'n'}` for numerics (and keep the raw display string in `m` when derivable)
- merges → `config.merge` entries `{r,c,rs,cs}` AND the anchor cell's `mc`
- column widths → `config.columnlen` (exceljs width ≈ chars → px conversion: use `Math.round(w * 7.5)` and note the approximation), row heights → `config.rowlen` (points→px `Math.round(h * 4/3)`)
- frozen panes: views[0].state==='frozen' → `frozen: {type: 'both'|'row'|'column', range: {row_focus: ySplit-1, column_focus: xSplit-1}}` per the FortuneSheet frozen shape
- borders → `config.borderInfo` best-effort (the d.ts types it `any[]` — mirror the shape FortuneSheet's own import produces; find one example in @fortune-sheet source/dist and cite it; if genuinely unstable, emit a warning and skip — warnings[] exists for this)
- unsupported content (charts/images/pivots/validation) → not rendered, one warning each ("preserved on save, not shown")

- [ ] **Step 1: Write the failing test.** Build the fixture IN the test with exceljs (no binary fixtures): a workbook with 2 sheets covering every mapping line (styled cells, formula with result, merge, widths/heights, frozen pane, numFmt) + write to buffer + run `workbookToFortuneSheets` + assert each mapping. Write all assertions out.
- [ ] **Step 2: Run to verify fail; implement.**
- [ ] **Step 3: Run** — test green (`npx vitest run --project ui src/utils/sheetBridge.import.test.ts`), full ui project green, lint clean.
- [ ] **Step 4: Commit**

```bash
git add src/utils/sheetBridge.ts src/utils/sheetBridge.import.test.ts
git commit -m "feat(sheets): exceljs->FortuneSheet fidelity import bridge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: sheetBridge — patch export (FortuneSheet → original workbook)

**Files:**
- Modify: `src/utils/sheetBridge.ts`
- Test: `src/utils/sheetBridge.patch.test.ts`

**Interfaces:**
- Produces:

```ts
// Patches the ORIGINAL workbook bytes with the FortuneSheet state and returns
// new xlsx bytes. Per sheet (matched by name): the cell grid (values, formulas,
// styles, merges, widths/heights, frozen) is REBUILT from the FortuneSheet
// state — including structural changes (rows/cols/sheets added or removed),
// because the state already reflects them. Workbook- and sheet-level artifacts
// the grid doesn't own (charts, images, pivots, defined names, validation)
// survive because we never recreate the workbook. LIMITATION (documented):
// cell-anchored artifacts do not shift when rows/cols moved.
export async function patchWorkbookFromFortuneSheets(
  originalXlsxBytes: ArrayBuffer | Buffer,
  sheets: FortuneSheetData[],
): Promise<Uint8Array>;
```

Behavior contract (tests):
1. Change one cell value → output preserves every other cell's style/value byte-meaningfully (reload output with exceljs and diff).
2. Untouched round-trip: import→patch with unchanged state → styles/merges/widths/frozen all survive (THE fidelity regression the old editor failed).
3. **Preservation centerpiece:** fixture with an embedded image (exceljs `addImage`) + a data-validation rule → change one unrelated cell → image + validation still present in output.
4. Structural: FortuneSheet state with a new sheet added and an existing sheet deleted → output workbook has matching sheets; renamed sheet (name change) → treated as delete+add (document; sheet-level artifacts on a renamed sheet are lost — emit warning) — OR match by stable order/id if FortuneSheet preserves an `id` — investigate `Sheet.id` and use it if it survives round-trips; document the choice.
5. Merges: removed merge in state → unmerged in output; new merge → merged.
6. Grid rebuild clears stale cells: a cell deleted in state is absent/empty in output.
7. Formula cells: `f` written as formula (leading `=` stripped for exceljs `{formula}`), cached result written when present.

- [ ] **Step 1: Write the failing tests (all 7).** Fixtures built in-test with exceljs.
- [ ] **Step 2: Implement** (unmerge-all-then-apply for merges; clear grid via iterating existing cells + `spliceRows` NOT used — plain cell-by-cell clearing of rows beyond the new occupied range; set `worksheet.views` for frozen).
- [ ] **Step 3: Run** — both bridge test files + full ui + lint.
- [ ] **Step 4: Commit**

```bash
git add src/utils/sheetBridge.ts src/utils/sheetBridge.patch.test.ts
git commit -m "feat(sheets): FortuneSheet->workbook patch export preserving non-grid artifacts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 26 + sheet session store

**Files:**
- Modify: `server/migrationList.ts` (+ its test if it asserts counts)
- Create: `server/realtime/sheetSessions.ts`
- Test: `server/realtime/sheetSessions.test.ts`

**Interfaces:**
- Migration 26 (ADDITIVE):

```sql
CREATE TABLE sheet_sessions (
  fileId TEXT PRIMARY KEY,
  state TEXT,              -- latest authoritative FortuneSheet Sheet[] JSON (from client state-sync)
  stateSeq INTEGER NOT NULL DEFAULT 0,   -- seq of the last op batch folded into state
  dirty INTEGER NOT NULL DEFAULT 0,      -- 1 = file bytes lag the working copy
  sessionOpen INTEGER NOT NULL DEFAULT 0,-- 1 = an editing session is live (participants > 0)
  snapshotDone INTEGER NOT NULL DEFAULT 0, -- 1 = this session's first-flush archive already happened
  updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sheet_ops (
  fileId TEXT NOT NULL,
  seq INTEGER NOT NULL,    -- monotonically increasing per file
  ops TEXT NOT NULL,       -- one opaque client op batch (JSON array), NEVER interpreted
  PRIMARY KEY (fileId, seq)
);
```

- `sheetSessions.ts` (in-memory registry + SQLite persistence; NO per-op file/DB reads beyond the appends):

```ts
export interface SheetSessionSnapshot { state: string | null; ops: string[]; seq: number }

export class SheetSessionStore {
  constructor(db: Database) {}
  // Join: loads (or creates) the session row; returns hydration payload.
  // `state` null means "no working copy yet — client must import the file itself
  // and push the first state-sync". ops = journal tail with seq > stateSeq.
  join(fileId: string, sessionId: string): SheetSessionSnapshot;
  leave(fileId: string, sessionId: string): { lastParticipant: boolean };
  participants(fileId: string): string[];
  // Appends an opaque op batch (SQLite INSERT), bumps seq, marks dirty; returns seq.
  appendOps(fileId: string, opsJson: string): number;
  // Debounced-authoritative full state from a client; folds the journal:
  // sets state, stateSeq = current max seq, DELETEs sheet_ops rows <= stateSeq, marks dirty.
  setState(fileId: string, stateJson: string): void;
  // Flush bookkeeping (the flush engine drives these):
  dirtyFiles(): string[];
  markFlushed(fileId: string): void;                 // dirty=0
  needsSessionSnapshot(fileId: string): boolean;     // sessionOpen && !snapshotDone
  markSessionSnapshotDone(fileId: string): void;
  closeSession(fileId: string): void;                // sessionOpen=0, snapshotDone=0 (next session re-arms)
  getState(fileId: string): string | null;
  // Crash recovery: rows with dirty=1 at construction stay dirty — the flush
  // engine picks them up; ops tail survives in sheet_ops (SQLite IS the journal).
}
```

Tests (write all): join-empty (null state, seq 0); appendOps seq monotonic + journal tail returned to a second joiner; setState folds journal (ops rows deleted, stateSeq advanced, later joiner gets state + only newer ops); leave lastParticipant bookkeeping; dirty lifecycle; snapshot arm/re-arm across two sessions; crash-recovery: build store #2 on the same db → dirty files and journal intact.

- [ ] **Step 1: Failing tests → Step 2: implement (migration + store) → Step 3:** full server project green (migration tests updated if they count migrations), lint clean.
- [ ] **Step 4: Commit**

```bash
git add server/migrationList.ts server/migrationList.test.ts server/realtime/sheetSessions.ts server/realtime/sheetSessions.test.ts
git commit -m "feat(sheets): migration 26 (additive) + shared sheet session store with op journal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Flush engine + per-session versioning

**Files:**
- Create: `server/realtime/sheetFlush.ts`
- Test: `server/realtime/sheetFlush.test.ts`

**Interfaces:**
- Consumes: `SheetSessionStore` (T3), `patchWorkbookFromFortuneSheets` (T2 — import from `../../src/utils/sheetBridge` — VERIFY the server tsx setup resolves this path (other server code importing src/? check; if not precedented, move the bridge to a root-level `shared/` folder or import via relative path — tsx handles TS anywhere in the repo; decide and document), file store read/write (`server/fileStore.ts` readFileContent/writeFileContent — read actual names), `saveNewVersion` (server/files.ts:253).
- Produces:

```ts
export interface SheetFlushOptions { intervalMs?: number }  // default 15_000
export class SheetFlushEngine {
  constructor(db: Database, store: SheetSessionStore, opts?: SheetFlushOptions) {}
  start(): void;   // interval scanning store.dirtyFiles(); unref()'d timer
  stop(): void;
  // Flush one file now: state → patch onto current live bytes → if
  // needsSessionSnapshot: saveNewVersion(bytes) [archives pre-session bytes,
  // overwrites live] + markSessionSnapshotDone; else direct in-place write.
  // markFlushed on success. Errors: log + leave dirty (retry next tick).
  flushFile(fileId: string): Promise<{ ok: boolean; error?: string }>;
  // Manual "Snapshot version": force an immediate flush that ALWAYS archives
  // (saveNewVersion), regardless of snapshotDone.
  snapshotNow(fileId: string): Promise<{ ok: boolean; version?: number; error?: string }>;
  flushAll(): Promise<void>;  // for last-leave + shutdown
}
```

Tests: in-memory db + real migrations + a seeded spreadsheet file (write real xlsx bytes via exceljs into the file store using the real upload path or `writeFileContent` directly); flushFile patches the cell value into the stored bytes (reload with exceljs, assert); first flush archives (a version row appears via the files version-chain query; read files.ts to assert correctly), second flush does NOT; snapshotNow always archives; crash-sim: mark dirty, new engine instance on same db, flushAll recovers; a null-state dirty row is skipped without error.

- [ ] **Steps: failing tests → implement → full server green + lint → commit**

```bash
git add server/realtime/sheetFlush.ts server/realtime/sheetFlush.test.ts
git commit -m "feat(sheets): autosave flush engine with per-session version snapshots

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Socket handlers + shutdown hook

**Files:**
- Modify: `server/realtime/registerRealtime.ts`, `server.ts`, `server/realtime/testHarness.ts` (pass-through for the new deps if needed)
- Test: `server/realtime/registerRealtime.sheets.test.ts`

**Interfaces (wire contract — client T6 consumes exactly these):**

```ts
// RealtimeOptions gains: sheetStore?: SheetSessionStore, sheetFlush?: SheetFlushEngine.
// server.ts constructs both (after db init), passes them in, calls flush.start(),
// and registers process handlers:
//   SIGTERM/SIGINT → await flushAll() → process.exit(0)   (new but small; log it)
// Error enum (documented in ONE comment block, mirroring measurement-op's):
//   not_in_sheet | file_not_found | not_spreadsheet | invalid_request | no_db | internal
//
// C→S 'sheet-join'  {fileId} +ack → {ok:true, state: string|null, ops: string[], seq: number,
//   participants: number} | {ok:false,error}
//   Membership: socket.rooms.has(sheetRoom(fileId)) (set-location already joins it on
//   /tools/sheets?fileId=...). Validates the file exists AND kind/mime is spreadsheet
//   (read file meta; 'not_spreadsheet' otherwise). Marks session open.
// C→S 'sheet-op'    {fileId, ops: string (opaque JSON), clientTabId} +ack → {ok:true, seq}|{..}
//   appendOps + socket.to(sheetRoom).emit('sheet-op-applied', {fileId, ops, seq, bySessionId: clientTabId})
// C→S 'sheet-state-sync' {fileId, state: string, clientTabId} +ack {ok:true}|{..}
//   store.setState (folds journal). NO broadcast (peers already applied the ops).
// C→S 'sheet-snapshot' {fileId} +ack {ok:true, version}|{..} — flushEngine.snapshotNow.
// C→S 'sheet-presence' {fileId, presence: {sheetId, r, c}} (no ack) →
//   socket.to(sheetRoom).emit('sheet-presence', {fileId, sessionId, name, color, presence})
//   (name/color from the socket's session registry entry).
// Disconnect/leave-room (set-location away): store.leave; if lastParticipant →
//   flushFile(fileId) then closeSession(fileId). Wire this into the existing
//   set-location room-leave path AND the disconnect handler — find both spots.
// Size guards: ops ≤ 1MB, state ≤ 25MB per message → 'invalid_request'.
```

- [ ] **Step 1: failing harness tests (write all):** join empty→null state; A ops → B receives `sheet-op-applied` with same opaque payload + seq; late joiner C gets state(after A's state-sync)+tail; state-sync folds (C joining after sees no stale ops); membership rejection (socket located elsewhere → not_in_sheet); non-spreadsheet file → not_spreadsheet; last-leave triggers flush (assert file bytes changed + session closed); presence relay carries name/color; oversized op → invalid_request.
- [ ] **Step 2: implement** (handlers + server.ts wiring + SIGTERM hook — the hook is best-effort: guard for test env).
- [ ] **Step 3:** full server green + lint.
- [ ] **Step 4: Commit**

```bash
git add server/realtime/registerRealtime.ts server/realtime/registerRealtime.sheets.test.ts server/realtime/testHarness.ts server.ts
git commit -m "feat(sheets): sheet-room collab handlers (opaque op relay, state sync, flush-on-leave) + shutdown flush

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Client context surface

**Files:**
- Modify: `src/context/CollaborationContext.tsx`
- Test: extend `src/context/CollaborationContext.test.tsx`

**Interfaces (mirror the WS4 ack-promise template exactly — `sendMeasurementOp`/`joinCanvas` at CollaborationContext.tsx:233-245):**

```ts
joinSheet: (fileId: string) => Promise<{ok:true; state: string|null; ops: string[]; seq: number; participants: number} | {ok:false; error: string}>;
sendSheetOp: (fileId: string, opsJson: string) => Promise<{ok:true; seq: number} | {ok:false; error: string}>;
sendSheetState: (fileId: string, stateJson: string) => Promise<{ok:true} | {ok:false; error: string}>;
requestSheetSnapshot: (fileId: string) => Promise<{ok:true; version?: number} | {ok:false; error: string}>;
sendSheetPresence: (fileId: string, presence: {sheetId: string; r: number; c: number}) => void;  // fire-and-forget
onSheetEvent: (cb: (ev: {kind:'op'; fileId: string; ops: string; seq: number; bySessionId?: string}
                     | {kind:'presence'; fileId: string; sessionId: string; name: string; color: string; presence: {sheetId:string;r:number;c:number}}) => void) => () => void;
// op/presence payloads carry clientTabId = CLIENT_SESSION_ID on send (self-echo parity).
```

- [ ] **Steps:** failing tests (ack resolution incl. offline; onSheetEvent subscribe/unsubscribe for both wire events mapped into the discriminated union) → implement → full ui green + lint → commit

```bash
git add src/context/CollaborationContext.tsx src/context/CollaborationContext.test.tsx
git commit -m "feat(sheets): client sheet-session surface (acked join/op/state/snapshot + presence)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Editor rebuild — fidelity + collab + autosave UI

**Files:**
- Modify: `src/pages/SpreadsheetEditor.tsx` (the core rewrite; current structure documented in its :33-590 — read fully first)

**Behavior contract (each numbered item is a review gate):**
1. **Import path:** xlsx files load via `workbookToFortuneSheets` (SheetJS import gone from the editor). csv keeps a values-only path (parse with SheetJS OR a tiny csv parse — keep whatever is simplest, csv is out of collab scope; document). xls → toast + read-only message "Legacy .xls — open in Excel and save as .xlsx to edit here". Warnings from the bridge surface once as a dismissible info line ("Charts/images preserved but not shown").
2. **Collab session (fileId tabs only):** on open: `joinSheet(fileId)` → if `state` non-null hydrate `<Workbook data>` from it and `applyOp` each journal tail batch via the ref (in seq order); if null, import the file bytes via the bridge and immediately `sendSheetState` (first-writer seeds the working copy). Subscribe `onSheetEvent`: foreign `op` events (bySessionId ≠ CLIENT_SESSION_ID, matching fileId) → `ref.applyOp(JSON.parse(ops))`.
3. **Sending:** `onOp={batch => ...}` — serialize + `sendSheetOp` (fire sequentially; queue while awaiting ack to preserve order; on `{ok:false}` non-offline → toast throttled). `onChange` → debounced (2s trailing) `sendSheetState(JSON.stringify(sheets))` — the authoritative sync (skip if no local op was sent since last sync — receivers' applyOp also fires onChange; track a `localDirtyRef` set in onOp, cleared on sync).
4. **applyOp loops guard:** applying foreign ops triggers `onOp` again? VERIFY against the d.ts/source (`applyOp` may or may not re-emit) — if it does, suppress with an `applyingRemoteRef` around the applyOp call; the test in step 1 of e2e will catch echo storms regardless. Document the finding.
5. **Autosave UI replaces Save:** for fileId xlsx tabs the Save button becomes a status chip ("Autosaves to file · Live" with participant count when >1) + a **Snapshot version** button (`requestSheetSnapshot` → toast "Version saved"). Save As (download) stays. Ad-hoc no-fileId tabs keep the old Download behavior + IDB persistence.
6. **Server per-user draft usage REMOVED for fileId sheets** (`putDraft`/`getDraft`/`deleteDraft` calls for kind 'sheet' deleted; the restore-draft confirm dialog goes with it). IDB tab-persistence stays for ad-hoc tabs; for fileId tabs the source of truth is the shared session (on reload, joinSheet re-hydrates).
7. **Cell presence:** hooks `afterSelectionChange(sheetId, selection)` → throttled (200ms) `sendSheetPresence(fileId, {sheetId, r, c})` (primary cell of the selection — read the Selection type). Foreign presence events → maintain a presences map → `ref.addPresences([...])` / `removePresences` on session-left (subscribe to the sessions list from context: when a session with that fileId location disappears, remove its presence; keep it simple — rebuild the full presence array on each event).
8. **useCollabEditing banner intentionally NOT added** — the live session UI (participant count) supersedes it for sheets (document in code comment).

- [ ] **Step 1: Read the current file fully; write the rewiring plan in your report first.**
- [ ] **Step 2: Implement.** Manual dev-server smoke of single-user open/edit (implementer-level; the e2e task proves it headlessly).
- [ ] **Step 3:** full `npm run test` + lint green (no new unit tests here — this task's coverage arrives in T9's e2e; the editor has zero existing tests to break, confirmed).
- [ ] **Step 4: Commit**

```bash
git add src/pages/SpreadsheetEditor.tsx
git commit -m "feat(sheets): editor rebuilt on the fidelity bridge with live collab session + autosave

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Documents "being edited" dots

**Files:**
- Create: `src/components/FileViewerDots.tsx`
- Modify: `src/pages/documents/DocumentsPage.tsx` (row markup — find the name cell)
- Test: `src/components/FileViewerDots.test.tsx`

**Interfaces:** mirror `PageViewerDots` (src/components/PageViewerDots.tsx) exactly, keyed on `s.location?.fileId === fileId` (sessions from `useCollaboration()`, excluding own session): up to 3 overlapping initial-circles, `title={name · device}`, null when none. Wire into the Documents row beside the file name (both table modes if two exist — read the file).

- [ ] **Steps:** failing RTL test (4 cases mirroring PageViewerDots.test.tsx) → implement + wire → full ui green + lint (existing DocumentsPage tests must pass — check its provider mocks; the dots component must degrade to null without a provider, same try/catch accessor pattern as useCollabEditing if needed) → commit

```bash
git add src/components/FileViewerDots.tssx src/components/FileViewerDots.test.tsx src/pages/documents/DocumentsPage.tsx
git commit -m "feat(sheets): live 'being edited' dots on document rows

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(Fix the `.tssx` typo above at execution time: `FileViewerDots.tsx`.)

---

### Task 9: E2E proofs, journal-replay-after-kill, checklist, push

**Files:**
- Create: `e2e/sheets-editor.spec.ts`, `e2e/collab-sheets.spec.ts`
- Modify: `e2e/fixtures/seed.ts` (spreadsheet seed helper: upload a styled xlsx built with exceljs via the file API, kind 'spreadsheet'), `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md`

- [ ] **Step 1:** `npm run test` + lint green.
- [ ] **Step 2: `sheets-editor.spec.ts` (single-user):**
  1. Open a seeded styled xlsx → grid renders values (assert a known cell text visible); no error toasts.
  2. Edit a cell → wait for autosave (poll the file's bytes via API: download `/api/files/:id/content`, parse with exceljs in the spec, assert the new value — this is THE data-loss regression proof, and it also proves formatting survived: assert the styled cell's font/fill unchanged).
  3. Click "Snapshot version" → file version count increments (documents/version API).
  4. Reload the editor → edited value still shown (session re-hydration).
- [ ] **Step 3: `collab-sheets.spec.ts` (two contexts via fixtures/collab):**
  1. A and B open the same sheet; A types into a cell; B sees the value live (poll the grid; FortuneSheet renders in canvas — assert via the ref/api through `page.evaluate` if DOM text isn't queryable; investigate what's assertable and document — fallback: B's cell-edit round-trip through A).
  2. B edits a different cell; A sees it.
  3. Late joiner C sees both edits without either A or B saving.
  4. A's presence: B sees a colored presence marker for A's selected cell (best-effort assertion; not the hard gate).
  5. Documents page in a 4th context shows the being-edited dots for the file.
- [ ] **Step 4: journal-replay-after-kill (server test, add to registerRealtime.sheets.test.ts or sheetSessions.test.ts):** simulate: join, ops appended, state synced, MORE ops appended, then build a fresh store+engine on the same db (the "restarted server") → a new joiner receives state + the op tail; flushAll flushes using last state (ops tail preserved in journal for the next joiner). Assert no data lost from SQLite. (This is the spec's "replay after kill" promise, adapted to the opaque-op design: the tail replays on the next CLIENT, then its state-sync makes the file whole.)
- [ ] **Step 5:** full `npm run test:e2e` (all specs incl. the two new ones, 3x stable for the new ones).
- [ ] **Step 6: Checklist** — tick all WS5 items with delivering hashes (per-task); the "Journal/working-copy storage decided" item cites T3's commit + "two additive tables"; add plan path under WS5 heading. **Also tick the three Post-project items ONLY if true (they are not — leave them).**
- [ ] **Step 7: Commit and push. The report MUST remind the controller: migration 26 runs on Nathan's next container pull — additive, but flag it to him per standing rule.**

```bash
git add e2e/sheets-editor.spec.ts e2e/collab-sheets.spec.ts e2e/fixtures/seed.ts docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md
git commit -m "test(sheets): single-user fidelity/autosave + two-context collab e2e; WS5 checklist complete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin testing
```

---

## Self-Review Notes

- **Spec §7 coverage:** fidelity import (T1), patch export preserving artifacts (T2), working copy + journal storage decision (T3 — two additive tables, drafts untouched), autosave flush ~15s/last-leave/shutdown + per-session snapshot + manual button (T4/T5), collab session per sheet room with late-joiner hydration (T3/T5/T7), cell presence (T5/T7), per-user draft replacement for sheets (T7), documents chip (T8), csv/xls guardrails (T7), round-trip fidelity tests (T1/T2/T9), journal-replay-after-kill (T9), two-context Playwright (T9).
- **Ruled deviations (from spec §7's letter, forced by the FortuneSheet reality — documented here):** (1) ops relay opaquely; the server working copy is maintained by debounced client full-state syncs, not server-side op application (the op format is internal immer patches; interpreting them would be reverse-engineering an undocumented grammar). (2) "Journal replay on restart" happens on the next joining CLIENT (state + tail → applyOp → fresh state-sync → flush), not server-side. (3) Structural export is grid-rebuild from state, not spliced ops — cell-anchored artifacts don't shift (documented limitation). (4) Cell presence is single-cell (FortuneSheet's Presence API), not range highlights.
- **WS4-carried notes honored:** no per-op DB reads (memory + appends); acked-op/join-snapshot/membership pattern mirrored; error enum documented in one block.
- **Known risk areas for reviewers:** T7 is the monolith rewrite (applyOp echo behavior must be verified, not assumed); T2's sheet-matching identity (name vs id); the T5 leave-flush wiring must catch BOTH set-location-away and disconnect; exceljs merge read-back API confirmed in T1.
- Line numbers as of `ef998ee` — locate by symbol when drifted.
