# Phase 5a — Math Lock-in Tests + CustomCostRow Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the safety net for the Phase 5 refactor: characterization unit tests that lock in the CURRENT behavior of `src/utils/math.ts` (measurement, scale conversion, cost calc, formula parsing — all currently untested), and dedupe the `CustomCostRow` component that is copy-pasted into both ProjectView and CanvasView.

**Architecture:** `math.ts` is pure and already well-isolated — we only ADD tests (`src/utils/math.test.ts`), changing no production code. `CustomCostRow` is extracted verbatim to `src/components/CustomCostRow.tsx` and imported by both monoliths; the one real divergence (a placeholder hint string) becomes an optional prop so both call sites keep their exact current text.

**Tech Stack:** Vitest (ui project, jsdom + globals), React 19, TypeScript.

**CRITICAL — these are CHARACTERIZATION tests:** they must assert what `math.ts` ACTUALLY does today, not what it "should" do. The plan gives traced expected values, but the implementer MUST run each function (or the test) and, if reality differs from the value written here, assert the REAL current output (and note it). The point is to detect future drift, so today's behavior is the source of truth. Do NOT "fix" a surprising-but-current behavior — capture it.

---

## File Structure

**Create:**
- `src/utils/math.test.ts` — characterization tests (Tasks 1–3 append to this one file)
- `src/components/CustomCostRow.tsx` — the extracted shared component

**Modify:**
- `src/pages/ProjectView.tsx` — remove the inline CustomCostRow, import the shared one
- `src/pages/CanvasView.tsx` — remove the inline CustomCostRow, import the shared one (pass its placeholder)

---

## Task 1: math.ts characterization tests — geometry & scale

**Files:** Create `src/utils/math.test.ts`.

Functions covered: `calculateDistance`, `calculatePolylineLength`, `calculatePolygonArea`, `isPointInPolygon`, `calculateRealValue`, `calculateSurfaceAreaPx`, `expandArcPoints` (smoke).

- [ ] **Step 1: Read** `src/utils/math.ts` lines 145–199, 448–458 so expected values are confirmed against the real code.

- [ ] **Step 2: Write the tests.** Vitest ui project uses globals (no imports of `it`/`expect` needed — match an existing `src/**/*.test.ts(x)`; if they import from 'vitest', follow suit).

```ts
import {
  calculateDistance, calculatePolylineLength, calculatePolygonArea,
  isPointInPolygon, calculateRealValue, calculateSurfaceAreaPx,
} from './math';
import type { ScaleConfig } from '../types';

describe('calculateDistance', () => {
  it('3-4-5 triangle', () => { expect(calculateDistance({x:0,y:0},{x:3,y:4})).toBe(5); });
  it('zero distance', () => { expect(calculateDistance({x:2,y:2},{x:2,y:2})).toBe(0); });
});

describe('calculatePolylineLength', () => {
  it('single segment', () => { expect(calculatePolylineLength([{x:0,y:0},{x:3,y:4}])).toBe(5); });
  it('two segments', () => { expect(calculatePolylineLength([{x:0,y:0},{x:0,y:10},{x:10,y:10}])).toBe(20); });
  it('empty/one point is 0', () => { expect(calculatePolylineLength([{x:1,y:1}])).toBe(0); });
});

describe('calculatePolygonArea (shoelace, abs)', () => {
  it('4x4 square = 16', () => { expect(calculatePolygonArea([{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}])).toBe(16); });
  it('triangle = 6', () => { expect(calculatePolygonArea([{x:0,y:0},{x:4,y:0},{x:0,y:3}])).toBe(6); });
  it('fewer than 3 points = 0', () => { expect(calculatePolygonArea([{x:0,y:0},{x:1,y:1}])).toBe(0); });
  it('winding order does not flip sign (abs)', () => { expect(calculatePolygonArea([{x:0,y:4},{x:4,y:4},{x:4,y:0},{x:0,y:0}])).toBe(16); });
});

describe('isPointInPolygon', () => {
  const sq = [{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}];
  it('inside', () => { expect(isPointInPolygon({x:5,y:5}, sq)).toBe(true); });
  it('outside', () => { expect(isPointInPolygon({x:15,y:5}, sq)).toBe(false); });
  it('degenerate polygon false', () => { expect(isPointInPolygon({x:0,y:0}, [{x:0,y:0},{x:1,y:1}])).toBe(false); });
});

describe('calculateRealValue', () => {
  const scale: ScaleConfig = { pixelDistance: 50, realWorldDistance: 10, unit: 'ft' } as any;
  it('length scales linearly (ratio 0.2)', () => { expect(calculateRealValue(100, 'length', scale)).toBeCloseTo(20, 10); });
  it('area scales by ratio squared', () => { expect(calculateRealValue(100, 'area', scale)).toBeCloseTo(4, 10); });
  it('count returns pixel value unchanged', () => { expect(calculateRealValue(100, 'count', scale)).toBe(100); });
  it('null scale returns pixel value', () => { expect(calculateRealValue(100, 'length', null)).toBe(100); });
  it('zero pixelDistance returns pixel value', () => { expect(calculateRealValue(100, 'length', { pixelDistance: 0, realWorldDistance: 10, unit: 'ft' } as any)).toBe(100); });
});

describe('calculateSurfaceAreaPx', () => {
  const scale: ScaleConfig = { pixelDistance: 1, realWorldDistance: 1, unit: 'ft' } as any;
  it('rectangle wall one-sided', () => { expect(calculateSurfaceAreaPx([{x:0,y:0},{x:10,y:0}], [5,5], false, scale)).toBe(50); });
  it('two-sided doubles', () => { expect(calculateSurfaceAreaPx([{x:0,y:0},{x:10,y:0}], [5,5], true, scale)).toBe(100); });
  it('null scale returns 0', () => { expect(calculateSurfaceAreaPx([{x:0,y:0},{x:10,y:0}], [5,5], false, null)).toBe(0); });
});
```

If `ScaleConfig` requires fields beyond `pixelDistance`/`realWorldDistance`/`unit`, read `src/types.ts` and supply them (the `as any` casts above already guard the test from missing optional fields — keep them only if needed).

- [ ] **Step 3: Run** `npx vitest run src/utils/math.test.ts`. Every assertion that disagrees with the real output: change the EXPECTED to the actual current value and add a `// characterization: current behavior` comment. All green.

- [ ] **Step 4: Commit**

```bash
git add src/utils/math.test.ts
git commit -m "test: lock in math geometry + scale conversion behavior"
```

---

## Task 2: math.ts characterization tests — units & cost

**Files:** Modify `src/utils/math.test.ts` (append).

Functions: `convertUnit`, `calculateTakeoffTotalCost`, `calculateTakeoffCostDetails`, `roundUpTo100`.

- [ ] **Step 1: Read** `src/utils/math.ts` lines 230–283, 304–362, 364–365 + the `MeasurementTakeoff`/`CustomCost` types in `src/types.ts`.

- [ ] **Step 2: Append tests:**

```ts
import { convertUnit, calculateTakeoffTotalCost, calculateTakeoffCostDetails, roundUpTo100 } from './math';

describe('convertUnit', () => {
  it('length ft→in = ×12', () => { expect(convertUnit(1, 'ft', 'in', 'length')).toBe(12); });
  it('length in→ft = ÷12', () => { expect(convertUnit(12, 'in', 'ft', 'length')).toBe(1); });
  it('area ft→in = ×144', () => { expect(convertUnit(1, 'ft', 'in', 'area')).toBe(144); });
  it('same unit returns value', () => { expect(convertUnit(5, 'ft', 'ft', 'length')).toBe(5); });
  it('count type returns value unchanged', () => { expect(convertUnit(5, 'ft', 'in', 'count')).toBe(5); });
  it('unknown unit returns value unchanged', () => { expect(convertUnit(5, 'ft', 'furlong', 'length')).toBe(5); });
  it('normalizes "sq ft"→"ft" for area', () => { expect(convertUnit(1, 'sq ft', 'sq in', 'area')).toBe(144); });
});

describe('calculateTakeoffTotalCost', () => {
  const adv = (customCosts: any[]) => ({ isAdvancedCost: true, customCosts } as any);
  it('flat sums the flat cost', () => { expect(calculateTakeoffTotalCost(adv([{ type:'flat', cost:100 }]), 50)).toBe(100); });
  it('yield = (total/yield)*cost', () => { expect(calculateTakeoffTotalCost(adv([{ type:'yield', yield:10, cost:5 }]), 100)).toBe(50); });
  it('yield with 0 yield contributes 0', () => { expect(calculateTakeoffTotalCost(adv([{ type:'yield', yield:0, cost:5 }]), 100)).toBe(0); });
  it('unit = total*costPerUnit', () => { expect(calculateTakeoffTotalCost(adv([{ type:'unit', costPerUnit:2 }]), 30)).toBe(60); });
  it('amount_per_units = (total/perUnits)*amount', () => { expect(calculateTakeoffTotalCost(adv([{ type:'amount_per_units', perUnits:5, amount:10 }]), 100)).toBe(200); });
  it('sums multiple custom costs', () => { expect(calculateTakeoffTotalCost(adv([{ type:'flat', cost:100 },{ type:'unit', costPerUnit:1 }]), 50)).toBe(150); });
  it('simple costPerUnit when not advanced', () => { expect(calculateTakeoffTotalCost({ costPerUnit:3 } as any, 10)).toBe(30); });
  it('no cost data = 0', () => { expect(calculateTakeoffTotalCost({} as any, 10)).toBe(0); });
});

describe('calculateTakeoffCostDetails', () => {
  it('returns per-line breakdown with quantity for yield', () => {
    const d = calculateTakeoffCostDetails({ isAdvancedCost: true, customCosts: [{ type:'yield', yield:10, cost:5, name:'Mud', unit:'bags' }] } as any, 100);
    expect(d.length).toBe(1);
    expect(d[0].costValue).toBe(50);
    expect(d[0].quantity).toBe(10);
    expect(d[0].quantityUnit).toBe('bags');
  });
  it('non-advanced returns []', () => { expect(calculateTakeoffCostDetails({} as any, 100)).toEqual([]); });
});

describe('roundUpTo100', () => {
  it('0 → 0', () => { expect(roundUpTo100(0)).toBe(0); });
  it('negative → 0', () => { expect(roundUpTo100(-5)).toBe(0); });
  it('exact 100 → 100', () => { expect(roundUpTo100(100)).toBe(100); });
  it('101 → 200', () => { expect(roundUpTo100(101)).toBe(200); });
  it('250 → 300', () => { expect(roundUpTo100(250)).toBe(300); });
});
```

- [ ] **Step 3: Run** `npx vitest run src/utils/math.test.ts`. Reconcile any expected vs actual (characterization rule). All green.

- [ ] **Step 4: Commit**

```bash
git add src/utils/math.test.ts
git commit -m "test: lock in unit conversion + takeoff cost behavior"
```

---

## Task 3: math.ts characterization tests — parsing & formatting

**Files:** Modify `src/utils/math.test.ts` (append).

Functions: `evaluateMathExpression`, `parseFeetAndInches`, `formatFeetAndInches`, `formatRealValue`, `formatMeasurement`.

- [ ] **Step 1: Read** `src/utils/math.ts` lines 3–68, 201–228, 367–446, 460–493. **These have fiddly branches — derive every expected value from the ACTUAL function (run it), then write the assertion.** Below are the cases to cover (fill expected from reality):

```ts
import { evaluateMathExpression, parseFeetAndInches, formatFeetAndInches, formatRealValue, formatMeasurement } from './math';

describe('evaluateMathExpression', () => {
  it('plain number', () => { expect(evaluateMathExpression('5')).toBe(5); });
  it('=2+3', () => { expect(evaluateMathExpression('=2+3')).toBe(5); });
  it('=10*2', () => { expect(evaluateMathExpression('=10*2')).toBe(20); });
  it('percentage =40% → 0.4', () => { expect(evaluateMathExpression('=40%')).toBeCloseTo(0.4, 10); });
  it('empty → null', () => { expect(evaluateMathExpression('   ')).toBeNull(); });
  it('non-numeric plain → null', () => { expect(evaluateMathExpression('abc')).toBeNull(); });
  it('illegal chars after = → null', () => { expect(evaluateMathExpression('=alert(1)')).toBeNull(); });
  it('malformed expression → null', () => { expect(evaluateMathExpression('=2+')).toBeNull(); });
});

describe('formatFeetAndInches', () => {
  it('0 → 0"', () => { expect(formatFeetAndInches(0)).toBe('0"'); });
  it('1.5 ft → 1\' - 6"', () => { expect(formatFeetAndInches(1.5)).toBe(`1' - 6"`); });
  // Cover a sub-inch fraction case and a sub-foot case — DERIVE the exact strings from the function output.
});

describe('parseFeetAndInches', () => {
  it('plain decimal feet', () => { expect(parseFeetAndInches('5')).toBe(5); });
  it('plain decimal as inches → /12', () => { expect(parseFeetAndInches('6','in')).toBeCloseTo(0.5, 10); });
  it('empty → null', () => { expect(parseFeetAndInches('')).toBeNull(); });
  // Add: explicit feet/inches like `5' 6"`, a bare fraction `1/2`, and `3 1/2` (default ft).
  // DERIVE each expected from the real function — these branches are subtle.
});

describe('formatRealValue / formatMeasurement', () => {
  it('count rounds + "each"', () => { expect(formatRealValue(3.7, 'count', 'each')).toBe('4 each'); });
  it('formatMeasurement falls back to px when no scale', () => { expect(formatMeasurement(12.5, 'length', null)).toBe('12.50 px'); });
  it('formatMeasurement area px fallback adds ²', () => { expect(formatMeasurement(12.5, 'area', null)).toBe('12.50 px²'); });
  // Add a length-with-scale case and an area-with-scale case using a known ScaleConfig;
  // DERIVE the exact formatted string (feet-inches vs decimal) from the real function.
});
```

**Important:** For every case marked "DERIVE", run the function with the input, observe the real return, and assert exactly that. If a case reveals behavior that looks like a bug (e.g. odd rounding), STILL assert the current output and add a `// characterization: note possible issue` comment — do NOT change `math.ts` in this task.

- [ ] **Step 2: Run** `npx vitest run src/utils/math.test.ts` → all green.

- [ ] **Step 3: Commit**

```bash
git add src/utils/math.test.ts
git commit -m "test: lock in formula parsing + measurement formatting"
```

---

## Task 4: Extract CustomCostRow to a shared component

**Files:**
- Create: `src/components/CustomCostRow.tsx`
- Modify: `src/pages/ProjectView.tsx` (remove inline def ~lines 33–158, import shared)
- Modify: `src/pages/CanvasView.tsx` (remove inline def ~lines 39–158, import shared, pass placeholder)

**Known divergence:** the two copies are identical EXCEPT one placeholder string — ProjectView uses `placeholder="e.g. bags"`, CanvasView uses `placeholder="e.g. days"` (on the `amount_per_units` "per-units unit" input; there may also be a `yield` "unit" input with `e.g. bags` in both — verify with a diff). Preserve both via an optional prop.

- [ ] **Step 1: Diff the two copies to confirm the exact divergence**

```bash
sed -n '33,158p' src/pages/ProjectView.tsx > /tmp/ccr_pv.txt
sed -n '39,158p' src/pages/CanvasView.tsx > /tmp/ccr_cv.txt
diff /tmp/ccr_pv.txt /tmp/ccr_cv.txt
```
Identify the exact end line of `CustomCostRow` in each file (it ends at the line before the next top-level `const`/`function`/comment — in ProjectView the next thing is `dataUrlToUint8Array`). Note every placeholder that differs.

- [ ] **Step 2: Create `src/components/CustomCostRow.tsx`** — paste the component body VERBATIM from ProjectView (the canonical copy), with these changes only:
  - Add the imports it needs at top: `import React from 'react';`, `import { Trash2 } from 'lucide-react';`, `import { evaluateMathExpression } from '../utils/math';`.
  - `export` the component (named export `CustomCostRow`).
  - Add an optional prop for the divergent placeholder(s). Extend the props type with `unitPlaceholder?: string;` and default it: `unitPlaceholder = 'e.g. bags'`. Replace the hardcoded `placeholder="e.g. bags"` on the `amount_per_units` per-units **unit** input (the line that differs between the two files) with `placeholder={unitPlaceholder}`. Leave any placeholder that is identical in both files (e.g. the `yield` "unit" field if it's `e.g. bags` in both) hardcoded as-is.
  - Change NOTHING else — same classes, same handlers, same logic.

- [ ] **Step 3: Wire ProjectView** — delete the inline `CustomCostRow` definition; add `import { CustomCostRow } from '../components/CustomCostRow';` (match the file's import style/path depth). ProjectView call sites pass NO `unitPlaceholder` (defaults to `'e.g. bags'` — its current text). Confirm `evaluateMathExpression` and `Trash2` are still imported/used elsewhere in ProjectView; if they become unused after removing the inline component, remove those now-dead imports (tsc will flag them).

- [ ] **Step 4: Wire CanvasView** — delete the inline `CustomCostRow` definition; add the same import. At CanvasView's call site(s), pass `unitPlaceholder="e.g. days"` to preserve its current text. Remove now-dead `evaluateMathExpression`/`Trash2` imports if they're no longer used in CanvasView (tsc will tell you).

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit            # clean — catches dead imports + prop mismatches
npm run lint
npm test                    # all green, including the new math tests
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/components/CustomCostRow.tsx src/pages/ProjectView.tsx src/pages/CanvasView.tsx
git commit -m "refactor: extract shared CustomCostRow, dedupe from ProjectView + CanvasView"
```

---

## Task 5: Full verification + push

- [ ] **Step 1: Full gate** — `npm run lint && npm test && npm run build` all green. Confirm the math test count (should add ~50+ assertions across math.test.ts).

- [ ] **Step 2: Visual sanity (note for Nathan)** — the CustomCostRow renders inside the Edit-Takeoff modal in BOTH the takeoff list (ProjectView) and the canvas right-sidebar (CanvasView). Manual check: open a takeoff's advanced cost editor in each place, switch between flat/yield/unit/amount-per-units, confirm the rows render and math-on-blur (`=2+2`) still works.

- [ ] **Step 3: Final review** — dispatch a code-review subagent (sonnet) over the 5a commit range. Focus: (1) the math tests are TRUE characterization (assert real current output, no production code changed in math.ts); (2) CustomCostRow extraction is byte-faithful except the parametrized placeholder — diff the new component against the old ProjectView copy to confirm no logic/class drift; (3) no dead imports; (4) both call sites preserve their original placeholder text. Fix any findings.

- [ ] **Step 4: Push** (this slice is pure tests + a safe extraction — no migration, no data risk):

```bash
git push origin testing
```

- [ ] **Step 5: Record memory** — note 5a shipped (math behavior locked in with N tests; CustomCostRow deduped); this is the safety net for the rest of Phase 5 (Proposal section 5b, Project Settings 5c, ⌘K actions 5d, monolith decomposition 5e).

---

## Self-Review Notes (author)

- **Characterization integrity:** Tasks 1–3 add ZERO production changes to `math.ts`. Any expected value that disagrees with reality is changed to match reality (current behavior is the contract). Surprising behaviors are captured + commented, not fixed — fixing math is out of scope for the safety-net slice.
- **Dedup faithfulness:** The extraction copies ProjectView's canonical CustomCostRow verbatim; the ONLY intentional change is parametrizing the one placeholder that differs between the two files, so both call sites keep their exact current hint text. tsc guarantees no prop/type drift and surfaces any now-dead imports.
- **Why this is first:** the spec (§8) mandates locking in measurement/cost behavior with tests BEFORE refactoring; the dedup removes the most painful duplication and proves the shared-component extraction pattern that 5e (full decomposition) will lean on heavily.
