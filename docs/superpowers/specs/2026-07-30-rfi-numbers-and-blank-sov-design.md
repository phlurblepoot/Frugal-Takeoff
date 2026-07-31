# RFI Number Non-Reuse + Blank SOV Download — Design Spec

Date: 2026-07-30
Status: Approved by Nathan

Two independent small changes, shipped together to `testing`.

## Change 1: RFI numbers are never reused

Problem: `createRfi` numbers via `MAX(number)+1`, so deleting RFI-007 makes the
next RFI also RFI-007. RFIs are formal documents referenced by number in
external correspondence; a duplicate number in a GC's file is a real problem.

### Migration 20 (`rfi-counter`), ADDITIVE

```sql
ALTER TABLE projects ADD COLUMN rfiCounter INTEGER NOT NULL DEFAULT 0;
```

Backfill in the same migration: for every project, set `rfiCounter` to
`COALESCE(MAX(number), 0)` over its existing `rfis`.

### `createRfi` change (server/rfiStore.ts)

Inside the existing transaction:

1. Read `rfiCounter` from the project row (the existing `requireProject` check
   guarantees the row exists).
2. Also read `COALESCE(MAX(number), 0)` from `rfis` for the project.
3. `number = max(rfiCounter, maxNumber) + 1` — belt-and-suspenders: the counter
   alone is authoritative going forward, but taking the max means numbering can
   never collide even if the counter were ever behind (e.g., imported data).
4. Insert the RFI with that number.
5. `UPDATE projects SET rfiCounter = <number>` .

No route, client, or UI changes. Project delete already removes the project row
(counter dies with it).

### Tests (server/rfiStore.test.ts)

- create RFI-001, RFI-002 → delete RFI-002 → create → gets **RFI-003** (not 002).
- delete ALL rfis → create → next number continues (does not reset to 001).
- migration backfill: a project with existing rfis gets `rfiCounter = MAX(number)`
  (implicitly covered by the above running on a migrated test DB — the sequence
  continues from pre-existing rows created before any counter update).
- existing numbering tests stay green.

## Change 2: Download blank SOV from Billing → SOV tab

Problem: the AIA Excel export button lives only inside the pay-app editor
modal, so with zero pay applications there is no way to download the SOV.
Nathan wants a zero-charge SOV workbook to present for approval before a
project starts.

Decision: the download is the **full G702+G703 workbook, zeroed** (or the
admin-uploaded template if configured) — identical format to pay-app exports.

### Extract shared export-context assembly

`AiaPayAppEditor.handleExport` (src/pages/project/billing/AiaPayAppEditor.tsx)
currently inlines: `getProject` + `getSettings` + `getAiaSettings` + logo
data-URL resolution + admin template resolution (fileId + mapping JSON parse,
fallback on failure). Extract that into a new module:

`src/pages/project/billing/aiaExportShared.ts`
- `resolveAiaExportEnv(projectId): Promise<{ project, settings, aiaSettings, company, template? }>`
  — company block `{name,address,phone,email,logoDataUrl}` assembled exactly as
  today; `template` is `{ buf: ArrayBuffer, mapping: AiaTemplateMapping }` when
  the admin template is configured and loads, undefined otherwise (same
  silent-fallback semantics as today, including the toast on template-load
  failure staying at the call sites).

`AiaPayAppEditor.handleExport` becomes a thin consumer. Behavior unchanged.

### Synthetic zero pay app (pure)

Same module exports a pure function:

`buildBlankSovContext(sovLines, aiaSettings): { app, g703, g702 }`

- `app`: `{ id: 'sov-preview', projectId, number: 0, periodTo: null, applicationDate: null, retainagePercent: aiaSettings.retainagePercent ?? 10, storedRetainagePercent: 0, status: 'draft', version: 1, createdAt: 0 }`
- per G703 row (one per SOV line, preserving sortOrder): `sovLineId`, `itemNo`,
  `description`, `isChangeOrder`, `scheduledValueCents` from the line;
  `previousCents = thisPeriodCents = storedCents = totalToDateCents = 0`,
  `percentComplete = 0`, `balanceToFinishCents = scheduledValueCents`,
  `retainageCents = 0`.
- `g702`: `L1 = Σ scheduledValue (non-CO)`, `L2 = Σ scheduledValue (CO)`,
  `L3 = L1+L2`, `L4/L5a/L5b/L5/L6/L7/L8 = 0`, `L9 = L3`; change-order
  additions/deductions/net from the CO sign split (positive scheduled values are
  additions, negative are deductions), mirroring server computeG702.

### Blank number/date rendering

`buildAiaWorkbook` and the template fill write `app.number` into the
"Application No" cell and use it in the filename. For the synthetic app
(`number === 0`), the Application No / Application Date / Period To cells are
left **blank** (empty string), not "0". Implement as a small guard in the
builders (`app.number > 0 ? app.number : ''`) — pay-app exports are unaffected
(numbers start at 1).

`exportAiaXlsx` gains an optional `filename` parameter (default stays
`AIA-<project>-App<number>.xlsx`); the SOV download passes
`AIA-<project>-SOV.xlsx`.

### UI

`AiaScheduleOfValues.tsx` CardHeader actions: new
`<Button size="sm" variant="secondary">` "Download SOV" with a
`<Download size={14} />` icon, alongside Seed/Sync/Upload. Disabled while
`busy` or when `lines.length === 0` (headers-only export not offered). On
click: `resolveAiaExportEnv` → `buildBlankSovContext` → `exportAiaXlsx` with
the SOV filename; template used when configured; errors toast like the pay-app
export does.

### Tests

- Pure tests for `buildBlankSovContext` (new file `aiaExportShared.test.ts`):
  rows zeroed with balance = scheduled, percentComplete 0; G702 L1/L2/L3/L9
  sums and zeroed L4-L8; CO additions/deductions split; retainage default
  fallback.
- `aiaExcel.test.ts`: one added test — workbook built from a zero context
  leaves the Application No cell blank and keeps TOTALS formulas.
- Existing 9 AIA Excel tests must stay green; pay-app export path unchanged
  (thin-consumer refactor is behavior-preserving).

## Out of scope

- No server changes for Change 2 (export remains fully client-side).
- No non-reuse counter for Issues (Issues are internal; numbering unchanged).
- No headers-only (zero-line) SOV export.
