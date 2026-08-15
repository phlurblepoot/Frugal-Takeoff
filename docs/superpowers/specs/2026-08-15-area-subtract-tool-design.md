# Area Subtract (Cutout) Tool — Design

Date: 2026-08-15
Status: Approved by Nathan (conversation)

## Problem

Area takeoffs (e.g. stucco/plaster on an elevation) need openings removed —
windows, doors, louvers. Today a user must mentally deduct them or draw
awkward workarounds; `Measurement.segments` only ever ADDS polygons.

## Decisions (agreed with Nathan)

- **Scope v1:** drawn polygon cutouts on `area`-type measurements only.
  Surface-area (length×height wall) deductions are a separate future feature.
- **UI entry:** a dedicated **Subtract tool** in the canvas toolbar (desktop +
  mobile), enabled only while an area measurement is selected and the page is
  editable.
- **Visuals:** true punch-out — the plan shows through the hole; hole boundary
  drawn dashed in the takeoff color. Sidebar lists holes as deductions.
- **Math:** signed sum per measurement, clamped at ≥ 0. No geometric
  containment validation in v1 (misplacement is visually obvious).

## Data model

`MeasurementSegment` gains `subtract?: boolean` (src/types.ts). Absent/false =
additive (all existing data unchanged — **no migration**). Cutouts are ordinary
segments of the parent measurement, so vertex editing, dragging, per-segment
selection/deletion, undo/redo, and plan-set revision copy-forward all work
unchanged.

## Math

New shared helper in `src/utils/math.ts`:

```ts
/** Net pixel area of an area measurement: additive segments minus subtract
 *  segments (arcs expanded), clamped at 0. */
export function measurementAreaPx(m: Pick<Measurement, 'points' | 'arcMidIndices' | 'segments'>): number
```

All current summation call sites for area-type measurements switch to it
(previously `[m.points, ...segments].reduce((s, pts) => s + calculatePolygonArea(pts), 0)`):
- proposalGenerator.ts totals + label + legend (3 sites)
- CanvasView legend/printout totals builder
- PdfCanvas live label
- MeasurementItem sidebar readout

`calculatePolygonArea` itself stays absolute-value (used for single polygons,
including computing a hole's own magnitude for sidebar display). Length and
count math untouched. Subtract flags on non-area measurements are ignored
(cannot be created via UI anyway).

## Tool behavior

- New tool id `subtract` (`Tool` union in types.ts). Toolbar button next to
  Area (desktop + mobile twins), `disabled` unless: not readOnly AND the
  selected measurement is `type === 'area'` (whole-measurement or any-segment
  selection counts). Deselecting while the tool is active reverts to `pan`.
- Drawing UX identical to the area tool (click/tap vertices; arcs supported
  exactly as far as the area tool supports them, since cutouts reuse the same
  drawing + segment-append code path — no separate arc handling).
- On finish (double-click / double-tap / Enter), the polygon is appended to
  the SELECTED measurement as `{ points, arcMidIndices?, subtract: true }`
  via the existing `finalizeSegment` append path (PdfCanvas.tsx:1026-1100) —
  never creates a standalone measurement. In-progress preview renders with
  dashed stroke + no fill.
- `deleteSegment` (CanvasView.tsx:899-960): deleting a hole just removes it.
  When the primary segment is deleted, promotion must skip subtract segments
  (a hole can never become the primary polygon); if only subtract segments
  would remain, the whole measurement is deleted.
- Read-only guards: the tool button disables, and the finalize/append path
  early-returns, following the existing per-handler guard pattern.

## Rendering (true punch-out, nonzero winding)

Shared ring-normalization helper (new `src/utils/polygonRings.ts` or in
math.ts): given a measurement's segments (arcs expanded), returns rings with
**winding normalized** — additive rings one direction, subtract rings
reversed — so the nonzero fill rule punches holes identically everywhere.

- **Canvas (Konva):** area measurements render their fill as ONE custom
  `Konva.Shape` whose `sceneFunc` traces all rings and fills once (nonzero
  default). Strokes stay as today's per-segment `<Line>`s (solid for additive,
  `dash` for subtract) so hit-testing, selection highlighting, and vertex
  editing stay untouched. In-progress subtract preview: dashed line, no fill.
- **Printout (pdf-lib):** proposalGenerator's area branch emits ONE compound
  SVG path (`M…Z M…Z` subpaths, holes reversed) for the fill via the existing
  `drawSvgPath`, plus separate dashed border paths for holes
  (`borderDashArray`). Numbers already correct via `measurementAreaPx`.

## Sidebar

`MeasurementItem` segment rows: subtract segments labeled as deductions
(e.g. "− 12.5 sq ft") with a distinguishing icon/prefix; measurement total uses
the clamped net value. Segment count text counts holes separately when present
("2 areas · 1 cutout").

## Testing

- Unit (math.test.ts + new): `measurementAreaPx` — hole reduces area, multiple
  holes, clamp at 0 when holes exceed parent, no-segment measurements,
  arc-expanded segments; ring normalization — hole winding reversed, additive
  preserved.
- E2E (canvas.spec.ts pattern at line 193): draw square area → assert value;
  select it, subtract tool, draw inner square → assert reduced value; undo
  restores. Playwright screenshot of the punch-out (house rule: canvas changes
  need real-browser proof).
- Read-only: superseded-revision page cannot use the subtract tool (extend the
  existing plan-set-readonly spec's approach).

## Out of scope (v1)

- Surface-area (length×height) deductions; typed/manual deductions.
- Geometric containment validation or overlap warnings.
- Converting existing additive segments to holes (redraw instead).
