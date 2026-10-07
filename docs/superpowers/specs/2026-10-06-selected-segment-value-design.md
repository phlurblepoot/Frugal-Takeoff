# Selected Segment Value — Design

Date: 2026-10-06
Status: Approved by Nathan (conversation)

## Problem

"Show amount of currently selected individual canvas measurement when
selected." A measurement's canvas label always shows the total of ALL its
segments; clicking one segment highlights it but never says what that one
segment is worth. Amount = quantity AND dollars.

## Decisions (agreed with Nathan)

- **Placement:** both a label on the selected segment AND a fixed info bar at
  the bottom of the canvas.
- **Segment label:** shown while one segment of a multi-segment measurement
  is selected (`selectedSegmentIdx` -1 = primary, 0+ = `m.segments[i]`), e.g.
  "420.00 sq ft · $1,470". A single-shape measurement's segment is the whole
  measurement (clicking it on the canvas selects segment -1), so it shows no
  second label or segment row — its total already says it. The
  measurement's total label stays. A cutout reads as a deduction:
  "−12.50 sq ft · −$44".
- **Quantity = that segment's own gross value:** length, area, or surface area
  (+ a length line) for a length measurement under an area takeoff, using the
  measurement's heights/isTwoSided — arcs expanded, region-aware scale and the
  takeoff's unit, exactly as the canvas label.
- **Dollars:** the segment's/measurement's share of the takeoff's cost by
  quantity, as the Takeoffs tab prorates page and measurement rows
  (`allocateSubsetCost`). Whole dollars, NOT rounded up to $100. A takeoff
  with no pricing shows the quantity only (no "$0").
- **Info bar** whenever one measurement is selected: name, takeoff + swatch,
  and the segment value + "Measurement total" (segment selected), the total
  (whole measurement), or "1 each · $…" + how many of the takeoff are on this
  page (count marker). Several multi-selected → "N selected" (the sidebar's
  wording). Hidden when nothing is selected.

## Design

**Maths — new `src/utils/segmentValue.ts`** (pure, unit-tested; PdfCanvas and
CanvasView only call it):

- `segmentPixelQuantity(m, seg, takeoffType, scale)` — one segment's own px /
  px² (negative for a cutout); surface area carries `lengthPixelValue`.
- `measurementPixelQuantity(...)` — the whole measurement, the same number as
  its canvas label (areas net of cutouts via `measurementAreaPx`).
- `measurementScale(page, m)` — region scale when calibrated, else the page's.
- `quantityInTakeoffUnits(q, ctx)` — real value converted the way
  `computeTakeoffTotals` converts (takeoff unit, else the page's scale unit).
- `takeoffHasPricing` / `prorateQuantityCost(totals, qty)` — wraps
  `allocateSubsetCost`; negative quantity → negative dollars; null = unpriced.
- `describeQuantity` → `{ quantity, length?, dollars? }`;
  `formatQuantityValue` → "qty · $"; `formatWholeDollars` → "$1,470" / "−$44".
- `labelAnchor` / `placeSegmentLabel` — where the segment label goes.
- `summarizeSelection(page, m, segIdx, takeoffs, costTotals)` — the bar's model.

**What dollars prorate against:** CanvasView memoizes
`computeTakeoffTotals(project, listPageIds)` — the Takeoffs tab's own totals
over the sidebar's default page set (current revision of every sheet, the
viewed revision for the viewed sheet). Identical to the Takeoffs tab whenever
the viewed page is the current revision; unaffected by "Current page only".
Passed to PdfCanvas as `takeoffCostTotals`. No existing total changes.

**Canvas label (PdfCanvas):** a Konva `Label`/`Tag` with the selection amber
(#fbbf24) behind bold black text, 14px/4px padding ÷ stageScale like the total
label. Built from the drag-adjusted geometry so it is live during vertex drags,
and rendered inside the segment's own subgroup so it follows segment drags.
Placement: the primary segment carries the total label, so its segment label
stacks just below it; another segment's label sits on that segment unless its
estimated box would hit the total label (e.g. a cutout centred in its wall),
in which case it also stacks below. Count markers have no segments → no label.

**Info bar (`src/components/canvas/SelectionInfoBar.tsx`):** HTML overlay in
CanvasView's canvas surface, centred, stacked directly above PdfCanvas's zoom
toolbar (`bottom-20` from md, `bottom-[8.5rem]` on phones where the zoom bar
sits at `bottom-20`), so it never meets the zoom bar or the tool-instructions
pill (`bottom-4`). `w-max` capped at the surface width, wraps on phones; only
its own footprint takes pointer events. Segment value wears the amber chip;
dollars use the sidebar's emerald. Reads the measurement from the page it
lives on (sidebar picks on another sheet use that sheet's scale).

**Length line wording:** the segment label/bar word a surface area's length in
the takeoff's LINEAR unit ("sqft" → "ft"; feet-inches with no takeoff unit).

## Tests

- `src/utils/segmentValue.test.ts`: per-segment length/area/cutout/surface/
  count quantities; arc expansion matches the label; segment lengths sum to the
  total; region scale fallback; unit conversion incl. page-unit fallback;
  pricing detection; proration = `allocateSubsetCost` (flat share + rates);
  whole-dollar/negative formatting; $ omitted when unpriced/unscaled; label
  placement (stack under total, own anchor, collision); `summarizeSelection`
  for whole/segment/cutout/stale index/count/ungrouped; agreement with
  `computeTakeoffTotals` + `allocateSubsetCost` on a project, and segment $
  summing to the measurement's.
- `src/components/canvas/SelectionInfoBar.test.tsx`: hidden with no
  selection; whole measurement; segment; cutout; no-$ + length line; count
  marker; multi-select count.
- E2E (`e2e/canvas.spec.ts`): priced area takeoff ($2/sq ft) → draw 50 sq ft →
  bar shows the total; cut a 12.5 sq ft hole → Pan → click the cutout's edge →
  bar shows "Cutout −12.5 sq ft · −$25" and the 37.5 sq ft total; screenshot;
  Escape hides the bar.
