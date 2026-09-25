# SOV Finalize, Header/Blank Lines, and Split-by-Percentage — Design

Date: 2026-09-11
Status: Approved by Nathan (conversation)

## Problem

1. Pay applications read description, scheduled value, and retainage **live**
   from `aia_sov_lines` on every compute (`server/aiaStore.ts` `computeG703` /
   `computeG702`). Nothing stops editing, deleting, seeding, or importing the
   SOV after a pay app exists, so an edit silently rewrites every prior pay
   app's G703/G702 figures. Deleting a line orphans its `aia_pay_app_lines`
   rows and shrinks every historical total.
2. The SOV can only hold item lines. Nathan's real schedules have section
   headers ("Drywall", "Level 6") and blank spacer rows, which the editor,
   pay-app editor, and Excel export cannot represent.
3. A line is often priced as one number and later broken out by area or
   phase. There is no way to split a line into parts; it has to be deleted
   and retyped, losing the original as a group label.
4. Change-order lines are mixed into the single SOV table in the editor even
   though the export already renders them as a separate section.

## Decisions (agreed with Nathan)

- **Finalize = lock.** Locking freezes the existing lines: no create, edit,
  delete, reorder, seed-from-estimate, sheet import, or split. Server-enforced
  (409 `sov_locked`), not just hidden in the UI.
- **Approved change orders still append while locked.** `syncChangeOrders`
  only ever inserts a CO line for a newly approved change order and never
  touches existing lines, which is how a G703 grows in practice.
- **Lock happens two ways:** manually from the SOV page ("Finalize SOV"), or
  automatically the moment the first pay application for the project is
  created.
- **Reopen is admin-only** and the client confirms with the number of pay
  applications that will recompute from edited values.
- **Headers are label-only.** A header row shows a bold description with
  empty amount columns in the SOV editor, the pay-app editor, and the Excel
  export. Blank rows are spacers and export as empty rows. No subtotals.
- **Split is allowed only while unlocked.** Once locked, an admin must reopen
  first (and the reopen warning applies). No pay-app progress is ever
  redistributed.
- **Change-order lines get their own read-only section** below the contract
  lines in the editor, matching the export.

## Data model (migration 35, additive)

### `aia_sov_lines.lineType`

```
ALTER TABLE aia_sov_lines ADD COLUMN lineType TEXT NOT NULL DEFAULT 'item'
```

- `item` — today's line; participates in every total.
- `header` — description (required, non-empty) and optional `itemNo`;
  `scheduledValueCents` forced to 0; `retainagePercent` forced NULL;
  `isChangeOrder` must be 0.
- `blank` — every field empty/0/NULL; `isChangeOrder` must be 0.

The server normalizes on write: a header/blank input with a value or
retainage is rejected with 400 (not silently zeroed), so a client bug cannot
smuggle money into a non-item row.

`AiaSovLine` (client, `src/utils/store.ts`) gains `lineType: 'item' | 'header' | 'blank'`.

### `aia_sov_locks`

```
CREATE TABLE aia_sov_locks (
  projectId      TEXT PRIMARY KEY,
  lockedAt       INTEGER NOT NULL,
  lockedByUserId TEXT,            -- NULL when locked by the system
  reason         TEXT NOT NULL    -- 'manual' | 'pay-app'
)
```

A row present = locked. Unlock deletes the row. A dedicated table (not a flag
inside `project.meta.aiaSettings`) because `PUT /api/projects/:id/aia/settings`
merges whatever object the settings form sends, so a stale form could
otherwise silently unlock the SOV.

### Backfill (the one behavior-changing step)

The migration inserts a lock row (`reason='pay-app'`, `lockedByUserId=NULL`,
`lockedAt=` the earliest pay app's `createdAt`) for every project that already
has at least one row in `aia_pay_apps`. This makes existing projects obey the
new rule; an admin can reopen with one click. The migration log line reports
how many projects were locked.

## Server

### Lock enforcement (`server/aiaStore.ts`)

- `getSovLock(db, projectId)` → `{ lockedAt, lockedByUserId, reason } | null`.
- `lockSov(db, projectId, { userId | null, reason })` — idempotent (an existing
  row is left untouched, so the first lock's cause is preserved).
- `unlockSov(db, projectId)` — deletes the row; stamps `touchProjectPayApps`
  (exports are now potentially out of date).
- `assertSovEditable(db, projectId)` throws `SovLockedError` (new class,
  message "Schedule of values is finalized — reopen it to make changes").
  Called at the top of `createSovLine`, `saveSovLine`, `deleteSovLine`,
  `seedSovLines`, `reorderSovLines`, `splitSovLine`. **Not** called by
  `syncChangeOrders`.
- `createPayApp` calls `lockSov(db, projectId, { userId: null, reason: 'pay-app' })`
  inside its transaction. (It is idempotent, so a manually locked SOV keeps
  `reason='manual'`.)
- `aiaErr` in `server/routes.ts` maps `SovLockedError` → 409 `{ error, code: 'sov_locked' }`.

### Routes (all `authenticateToken, requireAdmin`, same as the rest of AIA)

| Route | Purpose |
|---|---|
| `GET /api/projects/:id/aia/sov/lock` | `{ locked: boolean, lockedAt, lockedByUserId, lockedByName, reason, payAppCount }` |
| `POST /api/projects/:id/aia/sov/lock` | manual lock (`reason='manual'`, `lockedByUserId` = caller) |
| `DELETE /api/projects/:id/aia/sov/lock` | reopen |
| `PUT /api/projects/:id/aia/sov/order` | body `{ ids: string[] }` — the complete ordered list of **contract** line ids (every non-CO line exactly once, else 400); assigns `sortOrder` 0..n-1 |
| `POST /api/projects/:id/aia/sov` | unchanged, plus optional `lineType` and optional `insertBeforeId` (a contract line id; new line takes its `sortOrder`, that line and everything after shift +1) |
| `POST /api/aia/sov/:lineId/split` | body `{ version, parts: [{ description, percent }] }` — see Split |

Existing `GET /api/projects/:id/aia/sov` keeps returning the plain line array
(now including `lineType`); the client fetches lock state separately so no
consumer of the list shape changes. Every mutation broadcasts the existing
`aiaSov` change-feed event; lock/unlock broadcast `{ type: 'aiaSov', action: 'updated' }`
as well so open editors refresh their controls.

### Ordering rules

- Contract lines (`isChangeOrder=0`) are ordered by `sortOrder`; CO lines are
  partitioned out by `isChangeOrder` everywhere they are rendered or exported,
  regardless of `sortOrder` (the export already does this; the editor and
  pay-app editor will too). This means a contract line added after a CO sync
  never lands "below" the change orders.
- `insertBeforeId` and `reorder` operate on contract lines only; CO lines
  keep their sync order (by CO number, then `createdAt`).

### Split (`splitSovLine`)

Input validation (400 unless all hold):
- target line exists, `lineType='item'`, `isChangeOrder=0`, `version` matches (else 409 `version_conflict`);
- 2..50 parts; every `description` non-empty; every `percent` > 0;
- percents sum to exactly 100 when each is rounded to 2 decimals (the client
  enforces this before enabling the button; the server re-checks).

Transaction:
1. The original line becomes the header: `lineType='header'`,
   `scheduledValueCents=0`, `retainagePercent=NULL`, description and `itemNo`
   unchanged, `version+1`.
2. Children are inserted directly after it (`sortOrder` of every later
   contract line shifts by `parts.length`), in input order:
   - `itemNo` = `${parent.itemNo}.${i+1}` when the parent had one, else NULL;
   - `scheduledValueCents` = `Math.round(originalCents × percent / 100)` for
     all but the last child; the last child gets `originalCents − sum(others)`
     so the children always sum exactly to the original;
   - `retainagePercent` = the parent's former value (copied to every child);
   - `lineType='item'`, `version=1`.
3. `touchProjectPayApps` (no pay apps can exist while unlocked in the normal
   flow, but reopen-then-split is legal and must stale the exports).

Returns `{ header, children }`.

### Compute (`loadComputeContext`, `computeG703`, `computeG702`, billing summary)

- `G703Row` gains `lineType`. Header and blank rows are **kept in the row
  list in position** (so editors and exports can render them) with all money
  fields 0 and `percentComplete` 0.
- Every sum — G703 totals, contract and CO subtotals, G702 lines 1–9,
  retainage held/released, `billingStore` contract base and billed figures —
  iterates **only `lineType='item'` rows**. Exclusion is explicit
  (`if (row.lineType !== 'item') continue;`), not reliant on the value being 0.
- `createPayApp` seeds `aia_pay_app_lines` for item lines only.
  `savePayAppLines` ignores (does not store) input for non-item `sovLineId`s.
- `computeSovSeedFromEstimate` and `buildBlankSovContext` are unaffected in
  math; they carry `lineType` through.

## Client

### SOV editor (`src/pages/project/billing/AiaScheduleOfValues.tsx`)

- Header strip: status chip — **Draft**, or **Locked · Sep 11, 2026 · first pay
  application** / **· by Nathan**. Beside it **Finalize SOV** (confirm dialog:
  "Lock the schedule of values? Lines can't be changed until an admin reopens
  it.") or, when locked, **Reopen** (admin; confirm dialog: "Reopen the
  schedule of values? N pay application(s) will recompute from any values you
  change. Exports will be marked out of date.").
- Two sections: **Contract lines** (editable while unlocked) and **Change
  orders** (always read-only; shows item no, title, amount; "Sync approved
  change orders" button lives here and works in both states).
- Locked state: no inline edit, no delete, no add-line form, no Seed/Upload/
  Import, no row actions; rows render as plain text. A one-line note under
  the chip explains why.
- Row actions on contract lines (unlocked): **Move up**, **Move down**,
  **Insert header above**, **Insert blank above**, **Split…** (items only),
  **Delete**. Move up/down PUTs the full new order. Insert-above POSTs with
  `insertBeforeId`.
- Header rows: item-no + description inputs only; value/retainage cells
  empty; bold description. Blank rows: a faint "— blank —" marker, delete and
  move only.
- Add-line form gains a type selector (Item / Header / Blank) defaulting to Item.
- Version-conflict handling unchanged (409 → "Line changed elsewhere — reload").
- A `sov_locked` 409 anywhere → toast "Schedule of values is finalized" and
  refetch lock state (covers the race where another admin locks mid-edit).

### Split modal (`SplitSovLineModal.tsx`, new)

- Header: original description and formatted value.
- Rows: description input + percent input + computed dollar preview
  (same rounding as the server: last row shows the remainder). Starts with two
  rows prefilled "Part 1 / Part 2" at 50/50.
- **Add part**, **Even split** (distributes 100 evenly to 2 decimals, last row
  absorbs the remainder), remove-row on each row (min 2).
- Footer: "Remaining: x.xx%" (green at 0, red otherwise). **Split** button is
  enabled only when remaining is exactly 0.00 and every description is
  non-empty.
- On success: close, toast "Split into N lines", editor refetches.

### Pay-app editor (`AiaPayAppEditor.tsx`)

- Renders header rows as a bold full-width label (colspan across the money
  columns), blank rows as an empty spacer row; neither has inputs. The
  stacked mobile G703 does the same.
- Create-pay-app form (`AiaPayApplications.tsx`): when the SOV is unlocked,
  the form shows "Creating the first application finalizes the schedule of
  values." Once created, the SOV tab reflects the lock live via the change feed.

### Excel export (`aiaExcel.ts`, `aiaExcelTemplate` path)

- `writeItemRow` branches on `lineType`: header → description in the
  description column, bold, columns C..J empty; blank → empty row. Item rows
  unchanged. Both the default `buildG703` and the template-fill writer.
- Total rows already use range `SUM`s; empty cells are ignored, so
  `G703Anchors` and every G702 reference keep their meaning. The geometry test
  suite is extended with a header + a blank between items to prove it.
- The blank SOV download (`buildBlankSovContext`) carries header/blank rows through.

### Store (`src/utils/store.ts`)

New helpers: `getSovLock`, `lockSov`, `unlockSov`, `reorderSov(ids)`,
`splitSovLine(lineId, version, parts)`; `createSovLine` accepts `lineType` and
`insertBeforeId`. `SovLockedError` typed like `ProposalLockedError`.

## Out of scope

- Subtotals per header group (decided: label-only).
- Splitting on a locked SOV / redistributing pay-app progress.
- Snapshotting SOV lines per pay app (the lock is the guard; a reopen is a
  deliberate, warned action).
- Drag-and-drop reordering (move up/down + insert-above cover the need; a
  drag handle can be layered on later without API changes).
- Any change to the non-admin surface (AIA remains admin-only).

## Testing

Server (`server/aiaStore.test.ts`, `server/routes.test.ts`, `server/billingStore.test.ts`, migration test):
- lock: every mutating path (create/save/delete/seed/reorder/split) throws
  `SovLockedError` → route 409 `sov_locked`; `syncChangeOrders` still inserts
  while locked; `createPayApp` locks with `reason='pay-app'` and does not
  overwrite an existing manual lock; unlock stamps pay apps; lock GET reports
  `payAppCount` and the locker's name.
- migration 35: a project with pay apps is locked by the backfill, one
  without is not; `lineType` defaults to `item` on existing rows.
- header/blank: creating with money/retainage → 400; `computeG703` keeps them
  in position with zero money; G702 lines and retainage identical to a fixture
  without them (exact-cents assertions); `createPayApp` seeds lines for items
  only; billing summary contract base ignores them.
- reorder: rejects a partial/duplicate id list; assigns 0..n-1; CO lines untouched.
- insertBeforeId: shifts later lines; rejects a CO id.
- split: 60/40 of $10,000.00 → $6,000.00 + $4,000.00; 3-way of $100.01 →
  33.34 / 33.33 / 33.34 (last absorbs the remainder; sum exact); rejects 99.99
  and 100.01, one part, empty description, header target, CO target, stale
  version, locked SOV; parent becomes header with value 0 and `retainagePercent`
  copied to children; later lines' `sortOrder` shifted.

Client (vitest):
- `AiaScheduleOfValues`: draft vs locked rendering (controls present/absent),
  Finalize and Reopen confirm flows, CO section read-only in both states,
  `sov_locked` toast + refetch.
- `SplitSovLineModal`: remaining-percent math, even split, button gating, payload shape.
- `AiaPayAppEditor`: header/blank rows render without inputs.
- `aiaExcel.test.ts`: header + blank rows between items → item cells/formulas
  and every anchor/G702 reference unchanged; header cell bold; blank row empty.

Playwright (`e2e/aia-sov-finalize.spec.ts`, new):
- build an SOV (two items, insert a header above the second, add a blank,
  split the first item 60/40); create pay app #1 →
  SOV tab shows Locked, edit controls gone, CO sync button present; Reopen →
  controls back; edit a value → pay app 1's G703 reflects it (documenting the
  warned recompute).
