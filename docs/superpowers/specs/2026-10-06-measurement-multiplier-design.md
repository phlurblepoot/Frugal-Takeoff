# Measurement Multiplier — Design

Date: 2026-10-06
Status: Approved by Nathan (conversation)

## Problem

"Allow making a canvas measurement count more than once (for example, one page
counting for multiple floors)." Today a floor plan that is the same for four
floors has to be measured four times, or the totals are a quarter of the job.

## Decisions (agreed with Nathan)

- **Per measurement:** each length or area measurement (including a length
  priced as wall surface area under an area takeoff) can be given "× N". A
  whole number ≥ 1; 1 or unset means no multiplier. Input limit: 1–999.
- **Not for count markers** (declined). A stray multiplier on a count is
  ignored everywhere.
- **Show the math everywhere** one measurement's quantity is shown:
  "1250.00 sq ft × 4 = 5000.00 sq ft". **Every total** uses the multiplied
  quantity: page, takeoff, legend, Takeoffs tab, Excel, proposal, printout,
  Schedule of Values seed, dollar allocation.
- **No extras:** each place keeps its existing maths exactly (including the
  known differences between them — e.g. computeTakeoffTotals and the printout
  don't expand arcs, MeasurementItem gets the page scale, the SOV seed counts
  every page) and only multiplies its result.
- **Merge:** a multiplier belongs to the whole measurement, so only
  measurements whose multipliers match may merge; otherwise a toast says why
  and nothing merges.

## Design

**Data:** `Measurement.multiplier?: number` (src/types.ts). Stored only above
1 (`multiplierPatch(1)` clears it). Persistence needs no server change: every
measurement field beyond the core columns rides in the `attrs` JSON on both
the full-project save (server/projectStore.ts) and the realtime measurement
op (server/realtime/measurementOps.ts), and loads back the same way. Copy /
paste and carry-forward to a new revision spread the measurement, so the
multiplier goes with it. Undo/redo record it like any other updated field.

**Helper — `src/utils/multiplier.ts`:** `measurementMultiplier(m)` (1 for
count/unset/malformed), `multiplierPatch`, `parseMultiplierInput` (whole
1–999), `multipliedText(base, n, format)` → `{ math: "a × n =", total }`,
`formatMultiplied` (one line, just the value at × 1), `multipliersMatch`
(the merge rule). Every display formats the base and the total with the
formatter it already used, so units and wording are unchanged.

**Setting it:** the selected measurement's sidebar action strip
(MeasurementItem) gets **Multiplier** next to Edit Heights / Rename — never
for a count. It opens `MultiplierModal` (src/components/canvas) — "Counts ×",
validation hint, Enter saves, Escape/Cancel close. Save goes through
CanvasView's `updateMeasurement` (realtime op + undo/redo; a no-op when
read-only). On a read-only page (superseded revision / phone) the action
shows the existing read-only message instead of opening the editor. The row
shows a violet "×4" badge next to the name.

**Where it applies:**

| Place | Shows |
| --- | --- |
| Canvas label (PdfCanvas) | "a × n = b" (surface area: that line + the drawn Length line) |
| Selected-segment label + SelectionInfoBar (segmentValue) | segment and total "a × n = b · $", dollars of the multiplied quantity; cutouts "−a × n = −b · −$" |
| Sidebar row (MeasurementItem) | the total where the value always sits, and "a × n = b" on a line under the row (above would collide with the ACTIVE badge); cutout rows "−a × n = −b" |
| Sidebar takeoff totals (CanvasView), canvas + printout legends | multiplied totals |
| Printout label (buildHighlightsPdf) | "a × n = b" ("×" is WinAnsi 0xD7) |
| computeTakeoffTotals | each row `realValue` = base × n, plus `baseValue` and `multiplier`; page and takeoff totals sum the multiplied rows |
| Takeoffs tab measurement rows (desktop + mobile) | "a × n =" above the total |
| Excel (`src/pages/project/takeoffExcel.ts`, moved verbatim out of ProjectView) | Qty = multiplied; when any exported measurement is multiplied, two extra columns, Measured Qty and Multiplier (a number), filled on that row |
| Proposal lines, cost detail, SOV seed, cost shares | via computeTakeoffTotals (the proposal itemises takeoffs, not measurements; its highlighted plans carry the labels) |

The run length of a surface area stays the length drawn; only the quantity
(and its dollars) is multiplied. The merge banner also says "Different
multipliers — cannot merge", like its "Mixed types" hint.

## Tests

- `src/utils/multiplier.test.ts`: reading (count/unset/malformed → 1), patch,
  input parsing, math wording incl. a deduction sign, merge rule.
- `proposalGenerator.test.ts`: computeTakeoffTotals with multiplied length,
  area-with-cutout and surface-area measurements (totals, page breakdown, row
  base/multiplier), count unaffected. `proposalGenerator.highlights.test.ts`:
  printout label math and legend total.
- `costAllocation.test.ts`: a multiplied row's share (flat + unit) and shares
  summing to the takeoff. `store.test.ts`: SOV seed.
- `segmentValue.test.ts`: describeQuantity math + dollars, cutout, surface
  area, summarizeSelection whole/segment/cutout, count, agreement with
  computeTakeoffTotals. `SelectionInfoBar.test.tsx`: multiplied strings.
- `MeasurementItem.test.tsx`, `MultiplierModal.test.tsx`,
  `takeoffExcel.test.ts`, `planSets.test.ts` (carry-forward).
- Server: projectStore and measurementOps round-trip (and clearing).
- E2E (`e2e/canvas.spec.ts`): seeded priced takeoff → select the row →
  Multiplier ×2 → the row shows the math and badge, the sidebar total and
  selection bar double (screenshot); it survives a reload; the Takeoffs tab
  total doubles and the measurement row shows the math. A superseded
  revision shows the read-only message instead of the editor. Merging two
  measurements with different multipliers is refused (banner + toast).
