# AIA Retainage Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uniform base retainage rate by default (per-line as a toggle), one rate covering work + stored materials on new apps, and a percentage-point retainage-release mechanism on pay applications (with "Release all remaining") that compounds across the app chain.

**Architecture:** Effective-rate model — `aia_pay_apps.releasedRetainagePoints` (migration 22, additive); effective rate = snapshot base − cumulative released points over apps `number ≤ N`, clamped ≥ 0; `computeG703`/`computeG702` swap raw rates for effective rates so released dollars flow out through the untouched L5→L6→L7→L8 chain. Mode (`uniform`|`perLine`) lives in `project.meta.aiaSettings`.

**Tech Stack:** Express + better-sqlite3 (server/aiaStore.ts), React + TS editors, exceljs export, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-aia-retainage-rework-design.md` — read it first; its Math section is normative.

## Global Constraints

- Branch `testing` (commit; no pushes/PRs mid-plan).
- Migration 22 is ADDITIVE only (`releasedRetainagePoints REAL NOT NULL DEFAULT 0`).
- Legacy behavior must be byte-identical when no releases exist: old two-rate apps (distinct `storedRetainagePercent`) compute exactly as today — existing aiaStore tests covering legacy math must pass UNMODIFIED (the per-line-override test at aiaStore.test.ts:457-479 and stored-vs-work test at :420-452 in particular).
- Effective rates clamp at 0; over-release is a server-side ValidationError.
- Integer-cents discipline: round per line, never sum-then-round (matches aiaStore.ts's existing convention).
- Run `npx vitest run` (776 green at start) + `npx tsc --noEmit` before every commit. No Playwright (no AIA e2e exists; the controller runs the full suite before push).
- Never touch `data/`.

---

### Task 1: Server — migration 22, effective-rate math, release validation

**Files:**
- Modify: `server/migrationList.ts` (append migration 22, mirror migration 21's entry shape)
- Modify: `server/aiaStore.ts` (loadComputeContext ~357-378, computeG703 retainage ~400-403, computeG702 L5a/L5b ~447-498, createPayApp ~222-254, the pay-app update/patch function — find it, it validates rates 0-100 today)
- Modify: `server/routes.ts` ONLY if the pay-app PATCH route whitelists fields (read the route; add `releasedRetainagePoints` pass-through)
- Test: `server/aiaStore.test.ts` (append), `server/migrationList.test.ts` (append migration-22 presence/idempotency check following the file's pattern)

**Interfaces:**
- Consumes: existing `computeG702/computeG703/loadComputeContext`; `project.meta` (parse `aiaSettings.retainageMode`).
- Produces (Tasks 3/4 rely on these exact names):
  - Column `aia_pay_apps.releasedRetainagePoints` (REAL NOT NULL DEFAULT 0), settable via the existing pay-app update path, validated `0 ≤ points ≤ remainingReleasablePoints`.
  - `remainingReleasablePoints(db, payAppId): number` — exported; points still releasable BEFORE this app's own release: (uniform) `app.retainagePercent − cumulativeBefore` / (perLine) `max over SOV lines of (line.retainagePercent ?? app.retainagePercent) − cumulativeBefore`, floored at 0, where `cumulativeBefore` = Σ releasedRetainagePoints over the project's apps with `number < app.number`.
  - `computeG702` result gains a `retainage` block: `{ mode: 'uniform'|'perLine', baseWorkPercent: number, cumulativeReleasedPoints: number /* apps ≤ N incl. this app */, releasedThisApp: number, remainingPoints: number /* before this app's release */, effectiveWorkPercent: number|null /* uniform only; null in perLine */ }`.
  - `createPayApp`: when the resolved settings carry no explicit distinct stored rate (i.e. the new single-rate world — the UI stops sending `storedRetainagePercent`), persist `storedRetainagePercent = retainagePercent`.

- [ ] **Step 1: Failing tests** (append to aiaStore.test.ts; mirror its fixture helpers — read how it seeds projects/SOV/pay apps):

```ts
describe('retainage release (effective-rate model)', () => {
  // Base 15% uniform, one SOV line of $100,000, 50% complete on every app.
  it('release on app 2 reduces its retainage to the effective rate and pays out the delta via L8', () => {
    // app1: no release → L5a = 50000*0.15 = 7500_00... (use cents fixtures per file convention)
    // app2: same percentComplete, releasedRetainagePoints = 5
    //   → cumulative = 5, effective 10% → L5a = 5000_00
    //   → L8(app2) − withoutRelease equals exactly the released dollars (1500_00... adapt to fixture numbers)
  });
  it('release-all drives retainage to zero and the chain pays out all held retainage', () => {
    // app3 releases remainingReleasablePoints → effective 0 → L5 = 0;
    // Σ L8(1..3) === Σ earned totalToDate (no held retainage left)
  });
  it('remainingReleasablePoints subtracts prior releases and floors at 0', () => {});
  it('over-release is rejected with ValidationError', () => {});
  it('perLine mode: effective per-line rate = (line ?? base) − cumulative, clamped at 0', () => {
    // lines at 15% and 4%, release 5 → 10% and 0%
  });
  it('uniform mode ignores stray per-line retainage values', () => {
    // sov line has retainagePercent 20 but aiaSettings.retainageMode is 'uniform' (or absent) → app base used
  });
  it('legacy two-rate app with zero releases computes exactly as before', () => {
    // work 10 / stored 5, no releases → assert same numbers the existing stored-vs-work test shape produces
  });
  it('createPayApp with single-rate settings writes storedRetainagePercent = retainagePercent', () => {});
});
```

Write full concrete assertions (the comments above define the scenarios; pick fixture dollar values consistent with the file's existing style and compute expected cents by hand in the test).

- [ ] **Step 2: RED.** `npx vitest run server/aiaStore.test.ts`.

- [ ] **Step 3: Implement.**
  - Migration 22: `ALTER TABLE aia_pay_apps ADD COLUMN releasedRetainagePoints REAL NOT NULL DEFAULT 0` (guard with a PRAGMA column check for idempotency if the file's migration pattern does; read migration 16/21 for the idiom).
  - `loadComputeContext`: also load (a) `retainageMode` from the project's meta (`SELECT meta FROM projects WHERE id = ?`, parse, `aiaSettings?.retainageMode ?? 'uniform'`), (b) `cumulativeReleasedPoints` = `SELECT COALESCE(SUM(releasedRetainagePoints),0) FROM aia_pay_apps WHERE projectId = ? AND number <= ?`, (c) `releasedThisApp` = this app's own value.
  - Effective rates (one small helper used by BOTH computeG703 and computeG702 so they cannot drift):
    ```ts
    // Effective retainage after cumulative releases. Uniform mode ignores any
    // stray per-line values so the SOV toggle is authoritative, not the data.
    const effectiveWorkPct = (ctx: Ctx, sovLine: SovLine): number => {
      const base = ctx.mode === 'perLine'
        ? (sovLine.retainagePercent ?? ctx.app.retainagePercent)
        : ctx.app.retainagePercent;
      return Math.max(0, base - ctx.cumulativeReleasedPoints);
    };
    const effectiveStoredPct = (ctx: Ctx): number =>
      Math.max(0, ctx.app.storedRetainagePercent - ctx.cumulativeReleasedPoints);
    ```
    Swap into the retainage computations at computeG703 (~400-403) and computeG702's L5a/L5b accumulation. The L6/L7 recursion is untouched (prior apps' compute already uses their own cumulative sums).
  - `remainingReleasablePoints(db, payAppId)` per the Produces block (cumulative over `number < N`).
  - Update path: wherever pay-app rates are validated (0-100), accept `releasedRetainagePoints` with `typeof number && isFinite && points ≥ 0 && points ≤ remainingReleasablePoints(db, id)`; reject otherwise with the store's ValidationError. Bump version like other patches. Route whitelist updated if needed.
  - `computeG702` return: add the `retainage` block per Produces.
  - `createPayApp`: default `storedRetainagePercent` to the resolved `retainagePercent` when the caller doesn't send a distinct one.
- [ ] **Step 4: GREEN + full suites** (`npx vitest run && npx tsc --noEmit`) — legacy tests unmodified and green.
- [ ] **Step 5: Commit** — `feat(aia): retainage release engine — migration 22, effective rates, remaining-points validation`

---

### Task 2: Settings + SOV UI — mode toggle, single rate, column gating

**Files:**
- Modify: `src/components/AiaSettingsForm.tsx` (fields at ~20-31, 85-90)
- Modify: `src/components/AiaScheduleOfValues.tsx` (retainage column at ~35/41/258/292)
- Possibly: `src/utils/store.ts` aiaSettings type if one exists (grep `aiaSettings` in src/)

**Interfaces:**
- Consumes: `project.meta.aiaSettings` JSON (free-form; server does not validate fields).
- Produces: `aiaSettings.retainageMode: 'uniform' | 'perLine'` written by the settings form (absent = uniform); the form no longer renders/writes `storedRetainagePercent`; SOV column visibility driven by the mode.

- [ ] **Step 1:** AiaSettingsForm: replace the two rate fields with one "Retainage %" (writes `retainagePercent`; stop writing `storedRetainagePercent`); add a "Retainage mode" segmented toggle (Uniform rate / Per-line rates) writing `retainageMode`; short help text ("Per-line reveals a retainage column on the Schedule of Values; pay applications follow this choice"). Keep all non-retainage fields as-is.
- [ ] **Step 2:** AiaScheduleOfValues: read the mode (the component already receives settings or can via its parent — read how it gets aiaSettings; thread a prop if needed). In uniform mode: hide the per-line retainage column (header + inputs) and render a muted caption "Retainage: base rate N% applies to all lines (change in AIA settings)". In perLine mode: column as today with the placeholder indicating the base fallback.
- [ ] **Step 3:** `npx vitest run && npx tsc --noEmit` green; commit — `feat(aia): settings retainage mode toggle + single base rate; SOV column gated by mode`

---

### Task 3: Pay-app editor — Retainage panel with release controls

**Files:**
- Modify: `src/pages/project/billing/AiaPayAppEditor.tsx` (rate fields at ~209-210; G702 summary panel ~364-366) — confirm actual path via grep, explorer cited component names not full paths

**Interfaces:**
- Consumes: Task 1's `computeG702().retainage` block (mode, baseWorkPercent, cumulativeReleasedPoints, releasedThisApp, remainingPoints, effectiveWorkPercent) — check how the editor currently receives compute results (some GET returns g702/g703; the new block rides along) — and the pay-app update path now accepting `releasedRetainagePoints`.
- Produces: the two editable rate inputs are REMOVED; in their place a Retainage panel:
  - Uniform: "Base 15% · Released 5% · Effective 10%".
  - PerLine: "Per-line rates (see Schedule of Values) · Released 5%".
  - Number input "Release retainage on this application (% points)" bound to `releasedRetainagePoints` (free decimal, min 0, max = `remainingPoints` — which is defined BEFORE this app's own release, so it is the correct ceiling whether the draft's current value is 0 or already partially set), saved via the same patch/save flow as percentComplete edits.
  - Button "Release all remaining" → sets the input to `remainingPoints`, with the value in the label ("Release all remaining (10%)").
  - Both disabled when `status === 'finalized'`; server-side validation errors surface via the editor's existing toast/error pattern.
- [ ] **Step 1:** Implement (read the whole editor first; mirror its field/save idioms). **Step 2:** suites green; commit — `feat(aia): pay-app retainage panel — release points + release-all, rates read-only from settings`

---

### Task 4: Excel export — effective rates, per-line computed values

**Files:**
- Modify: `server/aiaExcel.ts` (single-rate R at ~319, G22 write at ~403, design comment ~126-134, template mapping ~480-523)
- Modify: `server/aiaExportShared.ts` only if the env needs the retainage block threaded (~25-86)
- Test: existing export tests if any (grep for aiaExcel in tests; else assert via the context-builder unit tests the file already has — read first)

**Interfaces:**
- Consumes: Task 1's `computeG702().retainage` block via the export env's existing ctx.
- Produces:
  - Uniform mode: `R = effectiveWorkPercent / 100` → G22; formulas unchanged. Update the ~126-134 design comment to describe the new behavior.
  - PerLine mode: G702 lines 5a/5b written as computed VALUES from ctx.g702 (no rate-driven formula for line 5), and any dependent formula that referenced G22 for line 5 must instead reference the written values (READ the formula wiring around lines 5/6/7 carefully; keep L6/L7/L8 as formulas over the now-literal 5a/5b cells so the sheet still recalculates). G703 per-row retainage column already carries per-line cents — unchanged.
  - Template-fill path: `retainageWorkPct`/`retainageStoredPct` cells receive effective rates (same value in the single-rate world; legacy apps keep their own).
- [ ] **Step 1:** Implement; add/extend a unit test asserting (a) uniform: G22 cell value = effective rate; (b) perLine: the 5a/5b cells are numeric literals equal to ctx.g702.L5a/L5b. **Step 2:** suites green; commit — `feat(aia): exports use effective retainage — uniform G22 rate, per-line computed values`

---

## Execution notes

- Waves: (T1 ∥ T2) → (T3 ∥ T4) → final whole-branch review → one fix wave → controller runs full Playwright suite → push.
- T1 and T2 are disjoint (server vs client-settings files). T3 and T4 both depend on T1 and are disjoint (editor tsx vs export ts).
- Remind Nathan at the end: migration 22 is additive/safe, but it still runs on pull; his manual eyeball = one release + one release-all + an exported workbook.
