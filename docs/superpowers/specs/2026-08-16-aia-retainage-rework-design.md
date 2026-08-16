# AIA Retainage Rework — Design

Date: 2026-08-16
Status: Approved by Nathan (conversation)

## Problem

1. SOV entry treats per-line retainage as the primary input (a per-line column,
   with the app-wide rate as fallback). Nathan wants the reverse: one base
   rate by default, per-line rates as an explicit secondary option.
2. Pay apps carry two independently editable rates (work + stored materials),
   duplicating what the SOV/settings chose.
3. There is no way to release (bill) held retainage. Today retainage is
   recomputed fresh from percentComplete each app; releasing requires manually
   lowering the rate with no memory, no validation, and no "final application"
   affordance.

## Decisions (agreed with Nathan)

- **One base rate** covers both completed work and stored materials for new
  apps (the G702 still reports 5a/5b separately, computed from the same
  rate). The separate stored-materials rate disappears from the UI; legacy
  finalized apps keep their historical two-rate snapshots and compute
  unchanged.
- **Retainage mode** per project: `uniform` (default — base rate applies to
  all lines) or `perLine` (per-line column revealed; blank lines fall back to
  the base). Pay apps follow the SOV's mode — never both.
- **Release = percentage points + "Release all remaining"** (effective-rate
  model, approach A): each app stores `releasedRetainagePoints`; effective
  rate = base − cumulative released points on apps `number ≤ N`, clamped ≥ 0
  (per line in perLine mode). Example: base 15, app 9 releases 5 → app 9
  computes retainage at 10% and pays out the released dollars via L8; app 10
  has 10 points remaining. Release-all on a final app drives retainage to 0.

## Data model

- `project.meta.aiaSettings` (JSON, no schema change): gains
  `retainageMode: 'uniform' | 'perLine'` (absent = `uniform`);
  `retainagePercent` stays the base rate; `storedRetainagePercent` is no
  longer written by the UI (legacy values remain readable for old apps).
- `aia_pay_apps`: **migration 22 (ADDITIVE)** — `releasedRetainagePoints REAL
  NOT NULL DEFAULT 0`. No data transform; safe auto-run on pull.
- `aia_sov_lines.retainagePercent` unchanged (used only in perLine mode).
- New pay apps snapshot base rate + mode at creation (as today via
  aiaSettings spread); `storedRetainagePercent` on new apps is written equal
  to `retainagePercent` so legacy readers stay coherent.

## Math (server/aiaStore.ts)

- `cumulativeReleasedPoints(ctx, N)` = Σ `releasedRetainagePoints` over the
  project's apps with `number ≤ N` (same number-chaining population the
  L6/L7 recursion already uses; draft/finalized status does not affect the
  sum, consistent with existing chaining).
- Effective work rate for a line on app N:
  - uniform: `max(0, app.retainagePercent − cumulative(N))`
  - perLine: `max(0, (sov.retainagePercent ?? app.retainagePercent) − cumulative(N))`
- Effective stored-materials rate =
  `max(0, app.storedRetainagePercent − cumulative(N))`. Because new apps
  write `storedRetainagePercent = retainagePercent`, this single rule gives
  both behaviors: legacy two-rate apps (cumulative 0) compute exactly as
  today, and new apps apply releases to stored retainage at the same single
  rate as work.
- `computeG703`/`computeG702` swap the raw rates for effective rates; nothing
  else changes (L1-L9 chaining untouched — released dollars flow out through
  L5 shrinking → L6 up → L8 up).
- Validation on saving `releasedRetainagePoints` for app N: `0 ≤ points ≤
  remaining(N)` where `remaining(N) = max effective base across relevant
  lines before this app's release` — concretely: uniform mode
  `app.retainagePercent − cumulative(N−1)`; perLine mode `max over lines of
  (line rate ?? base) − cumulative(N−1)`, floor 0. "Release all remaining"
  client button sets points = that remaining value.

## UI

- **AiaSettingsForm**: single "Retainage %" field (stored-materials field
  removed) + a "Retainage mode" toggle (Uniform / Per-line). Help text: mode
  drives the SOV column and all pay apps.
- **AiaScheduleOfValues**: per-line retainage column rendered only in
  perLine mode; uniform mode shows a one-line note of the base rate with a
  link/hint to settings. Change-order sync and xlsx upload unchanged (no
  retainage column in either — lines default to base).
- **AiaPayAppEditor**: the two editable rate fields are replaced by a
  read-only **Retainage panel**: base (or "per-line" note), previously
  released points, effective rate; a "Release retainage this application"
  number input (percentage points, step 0.5 or free decimal, validated
  against remaining) and a "Release all remaining" button; both disabled
  when finalized. G702 summary panel unchanged (values already recompute).
- Old draft apps created pre-change: their stored rates remain whatever was
  snapshotted; the panel shows them; releases work the same.

## Excel export (aiaExcel.ts)

- Uniform mode: single-rate cell `G702!G22` receives the app's **effective**
  rate; formula structure unchanged.
- perLine mode: G702 lines 5a/5b are written as **computed values** from
  `computeG702` (a single rate cell cannot represent mixed rates); the
  existing per-row G703 retainage figures continue to carry per-line detail.
  The known single-rate-collapse gap in the default export therefore closes
  for perLine projects.
- Admin template-fill: `retainageWorkPct`/`retainageStoredPct` mapping cells
  receive effective rates; per-row retainage cents already flow.

## Out of scope

- Retainage on the outstanding-balance surfaces (held retainage still isn't
  "outstanding"; releases surface automatically via L8 — no billingStore
  changes).
- A G702/G703 PDF (Excel-only remains).
- Per-line stored-materials overrides (never existed; still don't).

## Testing

- Unit (aiaStore.test.ts): effective-rate cascade across a 3-app chain
  (base 15, release 5 on app 2 → app 2 L5 at 10%, L8 pays out the delta;
  app 3 remaining 10); release-all → L5 = 0 and cumulative L8 equals total
  earned; over-release rejected (validation error); clamp at 0 with per-line
  rates below the released total; perLine mode uses line rates minus
  cumulative; legacy two-rate app (distinct stored rate, zero releases)
  computes byte-identically to today's expectations (existing tests stay
  green unmodified where they cover legacy behavior).
- Export: unit-test the workbook context values where feasible (effective
  rate lands in G22 for uniform; computed 5a/5b values for perLine).
- Manual: Nathan runs one release + one release-all flow in-app and eyeballs
  an exported workbook.
