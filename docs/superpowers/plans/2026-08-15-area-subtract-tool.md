# Area Subtract (Cutout) Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can draw polygon cutouts (windows/doors) that subtract from an existing area measurement — correct math everywhere, true visual punch-out on canvas and printouts.

**Architecture:** Cutouts are ordinary `MeasurementSegment`s flagged `subtract: true` on the parent measurement, so editing/undo/copy-forward work unchanged. A shared `measurementAreaPx` helper does the signed, clamped sum; a shared `measurementRings` helper emits winding-normalized rings so the nonzero fill rule punches holes identically in the Konva canvas (custom `Shape`) and pdf-lib printouts (compound SVG path). A dedicated `subtract` tool reuses the area tool's drawing + segment-append path.

**Tech Stack:** React + TS, react-konva (canvas), pdf-lib (printout), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-15-area-subtract-tool-design.md` — read it first.

## Global Constraints

- Branch: `testing` (commit here; no pushes mid-plan, no PRs).
- NO data migration: `subtract` is optional; absent = additive; all existing measurements render and compute exactly as before.
- Per-measurement net area clamps at ≥ 0. Subtract flags are only creatable on `area` measurements; math ignores them on other types.
- Read-only pages (superseded revision / phone): subtract tool disabled + append path guarded, following the existing per-handler guard pattern.
- Run `npx vitest run` (732 tests currently green) + `npx tsc --noEmit` before each commit.
- Never touch `data/` or live data. Never `git add` docs/*.pdf.
- Comments explain *why*, matching existing density/idiom.

---

### Task 1: Data model + signed area math (`measurementAreaPx`, `measurementRings`)

**Files:**
- Modify: `src/types.ts` (MeasurementSegment, line ~5)
- Modify: `src/utils/math.ts` (append after `isPointInPolygon`, ~line 181)
- Test: `src/utils/math.test.ts` (append)

**Interfaces:**
- Consumes: existing `expandArcPoints`, `calculatePolygonArea`, `Point`.
- Produces (later tasks import these exact names from `../utils/math` / `../../utils/math` etc.):
  - `MeasurementSegment.subtract?: boolean` (types.ts)
  - `signedPolygonArea(points: Point[]): number` — raw shoelace WITH sign (positive = counter-clockwise in screen coords).
  - `measurementAreaPx(m: { points: Point[]; arcMidIndices?: number[]; segments?: MeasurementSegment[] }): number` — arc-expanded net area, additive minus subtract, clamped ≥ 0.
  - `measurementRings(m: same shape): { points: Point[]; subtract: boolean }[]` — arc-expanded rings, winding-normalized: additive rings counter-clockwise (signed area ≥ 0), subtract rings clockwise. Rings with < 3 points are dropped.

- [ ] **Step 1: Write the failing tests** — append to `src/utils/math.test.ts` (match its existing import style; it already imports from `./math`):

```ts
describe('signedPolygonArea', () => {
  const ccwSquare = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
  it('returns signed area (sign flips with winding)', () => {
    const a = signedPolygonArea(ccwSquare);
    const b = signedPolygonArea([...ccwSquare].reverse());
    expect(Math.abs(a)).toBe(16);
    expect(b).toBe(-a);
  });
  it('returns 0 for degenerate polygons', () => {
    expect(signedPolygonArea([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
  });
});

describe('measurementAreaPx', () => {
  const outer = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]; // 100
  const hole = [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }];      // 4

  it('sums plain measurements exactly like the old per-polygon sum', () => {
    expect(measurementAreaPx({ points: outer })).toBe(100);
    expect(measurementAreaPx({ points: outer, segments: [{ points: hole }] })).toBe(104);
  });
  it('subtract segments reduce the net area', () => {
    expect(measurementAreaPx({ points: outer, segments: [{ points: hole, subtract: true }] })).toBe(96);
  });
  it('multiple holes all deduct', () => {
    const hole2 = [{ x: 6, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 8 }, { x: 6, y: 8 }];
    expect(measurementAreaPx({
      points: outer,
      segments: [{ points: hole, subtract: true }, { points: hole2, subtract: true }],
    })).toBe(92);
  });
  it('clamps at 0 when holes exceed the parent', () => {
    const bigHole = [{ x: -10, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 20 }, { x: -10, y: 20 }]; // 900
    expect(measurementAreaPx({ points: outer, segments: [{ points: bigHole, subtract: true }] })).toBe(0);
  });
  it('hole winding direction does not matter (magnitudes subtract)', () => {
    expect(measurementAreaPx({ points: outer, segments: [{ points: [...hole].reverse(), subtract: true }] })).toBe(96);
  });
});

describe('measurementRings', () => {
  const outer = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const hole = [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }];

  it('normalizes winding: additive rings positive, subtract rings negative', () => {
    const rings = measurementRings({
      points: [...outer].reverse(), // drawn clockwise — must be flipped
      segments: [{ points: hole, subtract: true }], // drawn ccw — must be flipped
    });
    expect(rings).toHaveLength(2);
    expect(rings[0].subtract).toBe(false);
    expect(signedPolygonArea(rings[0].points)).toBeGreaterThan(0);
    expect(rings[1].subtract).toBe(true);
    expect(signedPolygonArea(rings[1].points)).toBeLessThan(0);
  });
  it('drops degenerate rings', () => {
    expect(measurementRings({ points: outer, segments: [{ points: [{ x: 0, y: 0 }] }] })).toHaveLength(1);
  });
});
```

Add `signedPolygonArea, measurementAreaPx, measurementRings` to the test file's import from `./math`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/utils/math.test.ts`
Expected: FAIL — names not exported.

- [ ] **Step 3: Implement.** In `src/types.ts`:

```ts
export interface MeasurementSegment {
  points: Point[];
  arcMidIndices?: number[];
  /** Cutout: this polygon's area subtracts from the measurement's net area
   *  (windows/doors). Only meaningful on area measurements. */
  subtract?: boolean;
}
```

Append to `src/utils/math.ts` (after `isPointInPolygon`):

```ts
// Shoelace WITH sign — positive for counter-clockwise winding in screen
// coords. calculatePolygonArea (abs) stays for single-polygon magnitudes;
// this exists for winding-aware ring normalization.
export const signedPolygonArea = (points: Point[]): number => {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
};

type MeasurementGeometry = {
  points: Point[];
  arcMidIndices?: number[];
  segments?: MeasurementSegment[];
};

// Net pixel area of an area measurement: additive segments minus subtract
// segments (arcs expanded), clamped at 0 so an oversized hole can't drive a
// takeoff negative.
export const measurementAreaPx = (m: MeasurementGeometry): number => {
  const segs = [
    { points: m.points, arcMidIndices: m.arcMidIndices, subtract: false },
    ...(m.segments ?? []).map(s => ({ points: s.points, arcMidIndices: s.arcMidIndices, subtract: !!s.subtract })),
  ];
  const net = segs.reduce((sum, s) => {
    const a = calculatePolygonArea(expandArcPoints(s.points, s.arcMidIndices));
    return sum + (s.subtract ? -a : a);
  }, 0);
  return Math.max(0, net);
};

// Arc-expanded rings with winding normalized for nonzero-rule fills:
// additive rings counter-clockwise (positive signed area), subtract rings
// clockwise — so one compound path punches real holes in both the Konva
// canvas and the pdf-lib printout. Degenerate (<3 point) rings are dropped.
export const measurementRings = (m: MeasurementGeometry): { points: Point[]; subtract: boolean }[] => {
  const segs = [
    { points: m.points, arcMidIndices: m.arcMidIndices, subtract: false },
    ...(m.segments ?? []).map(s => ({ points: s.points, arcMidIndices: s.arcMidIndices, subtract: !!s.subtract })),
  ];
  const rings: { points: Point[]; subtract: boolean }[] = [];
  for (const s of segs) {
    const pts = expandArcPoints(s.points, s.arcMidIndices);
    if (pts.length < 3) continue;
    const signed = signedPolygonArea(pts);
    const wantPositive = !s.subtract;
    const isPositive = signed > 0;
    rings.push({ points: wantPositive === isPositive ? pts : [...pts].reverse(), subtract: !!s.subtract });
  }
  return rings;
};
```

Import `MeasurementSegment` into math.ts (it already imports `Point`; extend the same import from `../types`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/utils/math.test.ts` → PASS, then `npx vitest run && npx tsc --noEmit` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/utils/math.ts src/utils/math.test.ts
git commit -m "feat(subtract): MeasurementSegment.subtract + signed area math (measurementAreaPx, measurementRings)"
```

---

### Task 2: Subtract tool — toolbar, drawing, append, delete guards (CanvasView + PdfCanvas)

**Files:**
- Modify: `src/types.ts` (Tool union, line ~218)
- Modify: `src/pages/CanvasView.tsx` (toolbar desktop ~1250-1275 + mobile twin ~1865-1895, deleteSegment ~899-960, legend totals ~1092-1098)
- Modify: `src/components/PdfCanvas.tsx` (finalizeSegment ~1026-1105, preview ~1126-1165, label math ~1253, plus a full `currentTool` audit)

**Interfaces:**
- Consumes: `measurementAreaPx` from Task 1; existing `finalizeSegment` append path; `selectedMeasurementId`/`selectedSegmentIdx` selection model; `readOnly` guard pattern.
- Produces: `Tool` union includes `'subtract'`; drawing with the subtract tool appends `{ points, arcMidIndices?, subtract: true }` to the selected area measurement; Task 3 renders what this task stores. Toolbar button testid: `data-testid` not required (E2E task adds its own hooks if needed).

- [ ] **Step 1: Extend the Tool union** in `src/types.ts`:

```ts
export type Tool = 'pan' | 'scale' | 'length' | 'area' | 'count' | 'region' | 'subtract';
```

- [ ] **Step 2: Audit every `currentTool` site.** Run `grep -n "currentTool" src/components/PdfCanvas.tsx src/pages/CanvasView.tsx` (~64 hits) and READ each. Rule: `'subtract'` behaves exactly like `'area'` for *drawing mechanics* — click-to-add-point handling, preview rendering, closed-polygon behavior, Enter/double-click/double-tap finalize, Escape cancel, arc mode, cursor/crosshair, "drawing in progress" checks (e.g. `isDrawingTool`) — but must NEVER create a standalone measurement and never affect count/length/scale/region behavior. The cleanest mechanical approach: introduce a local helper in PdfCanvas (`const isAreaLikeTool = currentTool === 'area' || currentTool === 'subtract';`) and use it at the audited sites that currently test `currentTool === 'area'` for drawing mechanics. Do NOT blindly replace: sites that pick default colors/names for NEW measurements stay area-only.

- [ ] **Step 3: finalizeSegment subtract branch** (`PdfCanvas.tsx:1026`). Current code casts `const drawingType = currentTool as 'length' | 'area'`. Restructure:

```ts
    const isSubtract = currentTool === 'subtract';
    const drawingType = isSubtract ? 'area' : (currentTool as 'length' | 'area');
```

Then in the non-resume branch (`else` at ~1063): when `isSubtract`, ONLY append — never create:

```ts
      const selected = selectedMeasurementId
        ? measurements.find(m => m.id === selectedMeasurementId)
        : null;
      const canAppend = !!selected && selected.type === drawingType;

      if (isSubtract) {
        // Cutouts attach to the selected area measurement or nowhere — the
        // tool is gated on selection, so a miss just drops the polygon.
        if (canAppend && selected && selected.points.length > 0 && activePoints.length > 2) {
          const newSeg: MeasurementSegment = { points: segPoints, arcMidIndices: segArcMids, subtract: true };
          onUpdateMeasurement(selected.id, { segments: [...(selected.segments ?? []), newSeg] });
        }
      } else if (canAppend && selected) {
        // …existing append/create logic unchanged…
```

Also handle the `resumeMeasurementId` branch (~1041): when resuming a segment that has `subtract: true`, the rewrite at ~1045 must preserve the flag — change the mapped value to `{ ...s, points: segPoints, arcMidIndices: segArcMids }` (spread keeps `subtract`). Check whether "resume" can even start on a subtract segment; if the resume entry point is area-tool-only, still make the spread change (it is strictly safer).

- [ ] **Step 4: In-progress preview** (`PdfCanvas.tsx:1126-1165`): for subtract, dashed stroke, no fill, closed preview. Extend the color line and Line props:

```ts
    const selectedColor = selectedMeasurementId
      ? measurements.find(mm => mm.id === selectedMeasurementId)?.color
      : undefined;
    const color = currentTool === 'scale' ? '#ef4444'
      : currentTool === 'length' ? '#3b82f6'
      : currentTool === 'region' ? '#8b5cf6'
      : currentTool === 'subtract' ? (selectedColor ?? '#10b981')
      : '#10b981';
```

and on the preview `<Line>`: `dash` also when `currentTool === 'subtract'` (`[8 / stageScale, 6 / stageScale]`), `closed` also for subtract when `activePoints.length > 2 && arcMode === 'inactive'`, `fill` stays `undefined` for subtract.

- [ ] **Step 5: Toolbar buttons.** Desktop (after the Area ToolButton, `CanvasView.tsx:~1262`):

```tsx
            <ToolButton
              active={currentTool === 'subtract'}
              onClick={() => setCurrentTool('subtract')}
              icon={<SquareMinus size={18} />}
              label="Subtract"
              disabled={readOnly || !page.scaleConfig || hasNoSelection || activeType !== 'area' || !selectedMeasurementId}
              onDisabledClick={() => {
                if (readOnly) handlePhoneToolBlocked();
                else if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else setToolDisabledMessage("Select an area measurement to subtract from.");
              }}
            />
```

Note the extra `!selectedMeasurementId` condition: unlike Area, Subtract needs an actual selected measurement (a takeoff-only selection can't receive a hole). Add the identical button to the mobile toolbar twin (~1865-1895 — read it and mirror the surrounding pattern exactly). Import `SquareMinus` from `lucide-react` in CanvasView. Also: wherever CanvasView auto-resets the tool when selection changes/deselects (find the effect/handler that manages `currentTool` vs selection — e.g. where tools get locked by `activeType`), ensure a live `'subtract'` tool falls back to `'pan'` when the selected measurement stops being an area (deselect, delete, or type change). If no such reset effect exists, add one:

```ts
  useEffect(() => {
    if (currentTool === 'subtract' && (!selectedMeasurementId || activeType !== 'area')) {
      setCurrentTool('pan');
    }
  }, [currentTool, selectedMeasurementId, activeType]);
```

- [ ] **Step 6: deleteSegment hole guards** (`CanvasView.tsx:899-960`). Two edits in the `segmentIdx === -1` (primary deleted) branch: promotion must skip subtract segments —

```ts
      const extraSegs = measurement.segments ?? [];
      const promoteIdx = extraSegs.findIndex(s => !s.subtract);
      if (promoteIdx === -1) {
        // Only cutouts (or nothing) left — a hole can't become the primary
        // polygon, so the measurement is done.
        deleteMeasurement(measurementId);
        return;
      }
      const newPrimary = extraSegs[promoteIdx];
      const rest = extraSegs.filter((_, i) => i !== promoteIdx);
      updatedMeasurement = {
        ...measurement,
        points: newPrimary.points,
        arcMidIndices: newPrimary.arcMidIndices,
        segments: rest.length > 0 ? rest : undefined,
      };
```

The `segmentIdx >= 0` branch already just filters — correct for holes as-is, EXCEPT the "last segment left → delete measurement" check at ~936: extend it so a measurement whose primary is empty and whose remaining segments are all subtract also deletes:

```ts
      const noPrimary = !measurement.points || measurement.points.length === 0;
      if ((newSegs.length === 0 || newSegs.every(s => s.subtract)) && noPrimary) {
        deleteMeasurement(measurementId);
        return;
      }
```

- [ ] **Step 7: Switch the two area-math call sites in these files** to `measurementAreaPx` (import from `../utils/math` / `../../utils/math`):
  - `PdfCanvas.tsx:~1253` (live label): replace `allSegDisplayPoints.reduce((sum, pts) => sum + calculatePolygonArea(pts), 0)` with `measurementAreaPx({ points, arcMidIndices: m.arcMidIndices, segments: m.segments })` — note it must use the drag-adjusted `points` var, and segments already carry their own arcs. (The helper arc-expands internally; do NOT pass pre-expanded displayPoints.)
  - `CanvasView.tsx:~1098` (legend totals): same swap for the `takeoff.type === 'area' && m.type === 'area'` branch, using the measurement's raw geometry.
  Known consequence (conscious improvement, note in commit body): arc-carrying areas were inconsistently expanded across call sites before; the shared helper now always expands arcs.

- [ ] **Step 8: Verify + commit**

Run: `npx vitest run && npx tsc --noEmit` → green/clean.

```bash
git add src/types.ts src/pages/CanvasView.tsx src/components/PdfCanvas.tsx
git commit -m "feat(subtract): subtract tool — toolbar, draw/append flow, hole-aware segment deletion"
```

---

### Task 3: Canvas punch-out rendering (PdfCanvas)

**Files:**
- Modify: `src/components/PdfCanvas.tsx` (measurement render ~1189-1660)

**Interfaces:**
- Consumes: `measurementRings` (Task 1); Task 2's stored `subtract` flags; react-konva's `Shape` (add to the existing `react-konva` import).
- Produces: visual punch-out; per-segment strokes (incl. dashed hole strokes) unchanged in behavior for hit-testing/selection/editing.

- [ ] **Step 1: Compound fill shape.** In `renderMeasurements()`, for area measurements compute `const hasHoles = m.type === 'area' && (m.segments ?? []).some(s => s.subtract);`. When `hasHoles`, render ONE non-listening compound-fill Shape as the FIRST child of the measurement's outer Group (before the primary segment Group), and suppress the `fill` prop on ALL of that measurement's closed `<Line>`s (primary at ~1457 and per-segment at ~1595 — `fill={m.type === 'area' && !hasHoles ? … : undefined}`). When `!hasHoles`, render exactly as today (zero change for existing data). The Shape (uses the same drag-adjusted geometry: build a geometry object whose `points` are the drag-adjusted primary `points` var and whose `segments` are the drag-adjusted seg points — reuse the same adjustment code the Lines use):

```tsx
              <Shape
                listening={false}
                sceneFunc={(ctx, shape) => {
                  ctx.beginPath();
                  for (const ring of measurementRings(adjustedGeometry)) {
                    ring.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
                    ctx.closePath();
                  }
                  ctx.fillStrokeShape(shape); // nonzero rule + reversed hole winding = real hole
                }}
                fill={`${isMultiSelected ? '#f59e0b' : m.color}${isPrimarySelected ? '60' : isMultiSelected ? '50' : '40'}`}
              />
```

Build `adjustedGeometry` once per measurement render (primary drag-adjusted points + segments with their drag-adjusted points — the per-segment adjustment currently lives inside the segments map at ~1541; hoist a small helper so both the map and the Shape share it).

- [ ] **Step 2: Dashed hole strokes.** In the per-segment render (~1587-1617), when `seg.subtract`: add `dash={[10 / stageScale, 7 / stageScale]}` to the segment's main `<Line>` (and to its yellow selection-highlight Line at ~1575 keep the existing highlight dash). Everything else (hit-testing, dbl-click vertex insert, vertex circles, drag) stays identical.

- [ ] **Step 3: Manual-ish sanity via existing suites**

Run: `npx vitest run && npx tsc --noEmit` → green (rendering is E2E-verified in Task 5; don't hand-wave — Task 5's screenshot is the proof).

- [ ] **Step 4: Commit**

```bash
git add src/components/PdfCanvas.tsx
git commit -m "feat(subtract): true punch-out canvas rendering — compound nonzero fill + dashed hole strokes"
```

---

### Task 4: Sidebar deduction display (MeasurementItem)

**Files:**
- Modify: `src/components/canvas/MeasurementItem.tsx` (segment math ~130-160; read the whole file first)
- Test: none new (pure display; covered by E2E + existing component tests if present)

**Interfaces:**
- Consumes: `measurementAreaPx`, `calculatePolygonArea`, `expandArcPoints` (Task 1 / existing math).
- Produces: measurement total shows the clamped net; per-segment rows show holes as deductions.

- [ ] **Step 1: Net total.** Find the area-total computation (~line 153, `calculatePolygonArea` over `[m.points, ...segments]`) and replace with `measurementAreaPx(measurement)` for area-type measurements (length/count paths untouched).

- [ ] **Step 2: Per-segment rows.** Where segment rows render each segment's value (the `m.segments` map at ~142): for `seg.subtract`, prefix the formatted value with `−` (U+2212) and add a muted "cutout" annotation consistent with the file's existing row styling (read how rows label "Segment N" and mirror: e.g. label `Cutout N` and value `−12.5 sq ft`). Compute the hole's own magnitude with `calculatePolygonArea(expandArcPoints(seg.points, seg.arcMidIndices))` — magnitudes for display, sign carried by the prefix.

- [ ] **Step 3: Verify + commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/components/canvas/MeasurementItem.tsx
git commit -m "feat(subtract): sidebar shows cutout segments as deductions and net measurement totals"
```

---

### Task 5: Printout punch-out + totals (proposalGenerator)

**Files:**
- Modify: `src/pages/project/proposal/proposalGenerator.ts` (area drawing ~204-263, legend ~266-300, computeTakeoffTotals ~479-486)
- Test: `src/pages/project/proposal/proposalGenerator.highlights.test.ts` (append, if the file already tests area math paths — read it; otherwise unit coverage lives in Task 1 and math tests suffice)

**Interfaces:**
- Consumes: `measurementAreaPx`, `measurementRings` from `../../../utils/math` (Task 1).
- Produces: printout PDFs show real holes; all printed/proposal totals use net areas.

- [ ] **Step 1: Compound fill path.** In `buildHighlightsPdf`'s measurement loop (area branch ~203-223): today it iterates `allSegs` and emits one filled `drawSvgPath` per segment. Restructure for `m.type === 'area'`:
  - Build ONE compound path from `measurementRings(m)` — but scaled: each ring's points map through `* sf` exactly as today; subpaths concatenated: `M x0 y0 L x1 y1 … Z M … Z`.
  - Draw it once with the existing fill styling (`color: rgb(...)`, `opacity: 0.25`) and NO border, at `{ x: 0, y: dispH }` like today. pdf-lib fills with the nonzero rule, and `measurementRings` already reversed hole winding → real holes.
  - Then draw BORDERS per ring as separate unfilled `drawSvgPath` calls (same stroke width `3 * sf` as today's area stroke): solid for additive rings, `borderDashArray: [10 * sf, 7 * sf]` for subtract rings.
  - Length measurements keep the existing per-segment loop untouched.
- [ ] **Step 2: Totals swaps.** Replace the three area summations with `measurementAreaPx(m)`:
  - label text (~line 241 `else text = formatMeasurement(allSegPts.reduce(...calculatePolygonArea...))`) → `formatMeasurement(measurementAreaPx(m), 'area', page.scaleConfig, takeoff)`
  - legend per-takeoff totals (~line 282, the `takeoff.type === 'area' && m.type === 'area'` branch) → `measurementAreaPx(m)`
  - `computeTakeoffTotals` (~line 479-486, same-shaped branch) → `measurementAreaPx(m)`
  Surface-area (`calculateSurfaceAreaPx`) branches stay untouched. Note: the helper arc-expands, whereas ~241/~484 previously summed raw points — a conscious accuracy fix for arc-carrying areas; note it in the commit body.
- [ ] **Step 3: Tests.** Read `proposalGenerator.highlights.test.ts`; if `computeTakeoffTotals` has direct tests, add one: a project with an area takeoff + measurement (100 px² square + 4 px² subtract hole) yields the net (96-based) total. Follow the file's existing fixture style exactly.
- [ ] **Step 4: Verify + commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/pages/project/proposal/proposalGenerator.ts src/pages/project/proposal/proposalGenerator.highlights.test.ts
git commit -m "feat(subtract): printout compound-path holes + net area totals"
```

---

### Task 6: E2E — subtract flow, punch-out screenshot, read-only gate

**Files:**
- Modify: `e2e/canvas.spec.ts` (append; read the whole file + `e2e/fixtures/seed.ts` first and mirror patterns — especially the `'area measurement reads ~expected square feet'` test at ~193 and the read-only patterns in `e2e/plan-set-readonly.spec.ts`)
- Possibly modify: `src/pages/CanvasView.tsx` ONLY to add a stable hook on the Subtract ToolButton if ToolButtons lack one (check how existing e2e selects the Area tool first — mirror that; add `data-testid="tool-subtract"` only if needed).

**Interfaces:**
- Consumes: everything shipped in Tasks 1-5.

- [ ] **Step 1: Subtract-flow test.** Mirror the area test at ~193: seed/scale-calibrate as it does, draw a square area (assert its readout), then: select the measurement (however the area test leaves it selected — after drawing, the measurement is auto-selected per finalizeSegment), activate the Subtract tool, draw an inner square, finish (double-click), and assert the measurement readout/sidebar total decreased by the hole's expected amount (use the same tolerance idiom the area test uses). Then verify undo (mirror the undo test at ~304): one undo removes the cutout and restores the original value.
- [ ] **Step 2: Punch-out screenshot.** In the same test, `await page.screenshot({ path: 'test-results/subtract-punchout.png' })` after drawing (house rule: canvas changes need visual proof — the screenshot is reviewed by a human, the assertion is the numeric one).
- [ ] **Step 3: Read-only gate test.** Following `plan-set-readonly.spec.ts` patterns: on a superseded-revision page, the Subtract tool button is disabled.
- [ ] **Step 4: Full verification**

Run: `npx vitest run` → green; `npx tsc --noEmit` → clean; `npx playwright test` → ALL specs green (build takes minutes; be patient). The gated printout-email-large spec will also run if the big fixture exists — that's fine.

- [ ] **Step 5: Commit**

```bash
git add e2e/canvas.spec.ts src/pages/CanvasView.tsx
git commit -m "test(e2e): subtract tool flow, punch-out screenshot, read-only gate"
```

---

## Execution notes

- Wave 1: Task 1 alone (everything imports it). Wave 2: Task 2 ∥ Task 4 ∥ Task 5 (disjoint files: CanvasView+PdfCanvas+types / MeasurementItem / proposalGenerator). Wave 3: Task 3 (PdfCanvas again, after Task 2). Wave 4: Task 6. Then whole-branch review + fix wave, then push to `testing`.
- Task 2 is the riskiest (64-site currentTool audit) — implementer must READ each hit, not pattern-replace.
