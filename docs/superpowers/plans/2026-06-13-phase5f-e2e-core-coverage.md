# Phase 5f — E2E Test Pass for the Deferred Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build a Playwright E2E suite that **characterizes the current behavior** of the deferred monolith core — the ProjectView pages grid / takeoffs table and the CanvasView scale-calibration + measurement-drawing engine — so that core can later be safely decomposed (the spec §8 "lock in behavior with tests *before* refactoring" principle, applied to the canvas/takeoff UI that has zero automated coverage today).

**Scope:** CRITICAL-PATH characterization, not exhaustive. The crown jewel is the **scale → draw → measured-value → takeoff/cost** pipeline (CanvasView), plus the highest-value ProjectView pages/takeoffs interactions and the export downloads. Comprehensive coverage of favorites/context-menus/multi-select/revisions/collaboration is explicitly out of scope for this pass.

**Architecture:** Playwright drives a real Chromium against the production-style single-origin server (`tsx server.ts` serving a fresh `vite build` of `dist/` + the API on `:3000`). A dedicated temp `STORAGE_PATH` gives each run a clean SQLite DB (migrations run on boot; a fresh DB bootstraps the `admin`/`admin` user). Tests seed fixtures via the API (`request` context), authenticate by injecting the JWT into `localStorage` (`storageState`), and assert against the real rendered UI. Canvas determinism is achieved **self-referentially** (calibrate scale and measure using the same screen coordinates → proportional assertions that don't depend on exact pixel→image mapping or zoom).

**SAFETY INVARIANT:** This phase ADDS tests + a small amount of `data-testid` instrumentation only. It must not change any app behavior. `tsc`/existing `npm test`/`build` stay green. The new E2E suite is a separate runner (`npm run test:e2e`), NOT part of `npm test` (it's slower + needs a browser).

**Tech Stack:** `@playwright/test` (Chromium), the existing Express+SQLite server, React 19 frontend. Reuse the seeding patterns from the manual smoke runs (login admin/admin → token; `POST /api/projects`, `POST /api/images`).

**Key references:**
- Server boot + static serve: `server.ts` (`express.static(dist)` + SPA fallback ~841; `httpServer.listen(PORT)` ~855; `PORT`/`STORAGE_PATH` env).
- Auth: `POST /api/auth/login` (admin/admin) → `{ token, user }`; the app stores `localStorage.token` + `localStorage.user`.
- Fixtures: `POST /api/projects` (body is a full Project: id, name, createdAt, pages[], takeoffs[]); `POST /api/images` `{ id, data: dataUrl }` → served at `/api/images/:id/raw`. A `ProjectPage` needs `{ id, name, imageId, imageWidth, imageHeight, measurements:[], scaleConfig }` (see `src/types.ts`).
- The deferred-core regions (from the 5e map): ProjectView pages grid/list + takeoffs table; CanvasView drawing core (`startMeasurement`/`addPoint`/`finishMeasurement`), scale calibration (`confirmScale`), right-sidebar measurement list, `MeasurementItem`/`ToolButton`.
- Math already unit-tested (5a) + costAllocation (5e) — E2E asserts the INTEGRATION (clicks → measurement → displayed value/cost), not the formulas.

---

## File Structure

**Create:**
- `playwright.config.ts` — config (webServer, baseURL, chromium, viewport, trace-on-failure)
- `e2e/fixtures/test.ts` — custom test fixtures (authed page, API seeder)
- `e2e/fixtures/seed.ts` — API helpers: login, create project, upload fixture image, build a page
- `e2e/fixtures/assets/test-page.png` — a known-dimensions solid image used as a project page
- `e2e/pages.spec.ts` — ProjectView Pages tab
- `e2e/takeoffs.spec.ts` — ProjectView Takeoffs tab (create/edit/delete/totals)
- `e2e/canvas.spec.ts` — CanvasView scale calibration + drawing (the crown jewel)
- `e2e/export.spec.ts` — Excel/proposal download
- `e2e/README.md` — how to run

**Modify:**
- `package.json` — add `@playwright/test` devDep + `test:e2e` script
- `.gitignore` — ignore `test-results/`, `playwright-report/`, `.e2e-data/`, `e2e/.auth/`
- A handful of source files — add stable `data-testid` attributes to the canvas, toolbar tools, measurement-sidebar rows, takeoff table rows, and key buttons (additive, no behavior change)

---

## Task 1: Playwright install + config + trivial smoke

**Files:** Create `playwright.config.ts`; modify `package.json`, `.gitignore`; create a throwaway `e2e/smoke.spec.ts`.

- [ ] **Step 1:** Add the dev dependency and browser: `npm i -D @playwright/test` then `npx playwright install chromium`. Add scripts to package.json: `"test:e2e": "playwright test"`, `"test:e2e:ui": "playwright test --ui"`.

- [ ] **Step 2:** Create `playwright.config.ts`:
  ```ts
  import { defineConfig, devices } from '@playwright/test';
  export default defineConfig({
    testDir: './e2e',
    fullyParallel: false,            // single shared server + DB; keep deterministic
    workers: 1,
    timeout: 30_000,
    retries: process.env.CI ? 1 : 0,
    use: {
      baseURL: 'http://localhost:3000',
      trace: 'on-first-retry',
      screenshot: 'only-on-failure',
      viewport: { width: 1440, height: 900 },   // fixed for deterministic canvas coords
    },
    webServer: {
      // Build the SPA, then run the server which serves dist/ + the API on :3000.
      command: 'npm run build && STORAGE_PATH=.e2e-data npx tsx server.ts',
      url: 'http://localhost:3000',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: { STORAGE_PATH: '.e2e-data', PORT: '3000' },
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  });
  ```
  (Confirm the server reads `STORAGE_PATH`/`PORT` from env — it did in the smoke runs. If a fresh `.e2e-data` must be wiped each run, add a `globalSetup` that `rm -rf`s it before the server starts — but webServer starts before globalSetup runs in Playwright, so instead wipe `.e2e-data` in the `test:e2e` script: `"test:e2e": "rm -rf .e2e-data && playwright test"`.)

- [ ] **Step 3:** `.gitignore`: add `test-results/`, `playwright-report/`, `.e2e-data/`, `e2e/.auth/`.

- [ ] **Step 4:** Throwaway `e2e/smoke.spec.ts`: navigate to `/`, expect to be redirected to `/login` (or the login form visible). Run `npm run test:e2e` → green. This proves the harness boots the built app.

- [ ] **Step 5:** Confirm the existing gates are unaffected: `npm run lint`, `npm test` (unit), `npm run build` still green (Playwright config/tests are isolated from vitest — verify vitest doesn't try to run `e2e/*.spec.ts`; if vitest's `include` would pick them up, exclude `e2e/**` in `vitest.config.ts`).

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts package.json package-lock.json .gitignore e2e/smoke.spec.ts vitest.config.ts
git commit -m "test(e2e): add Playwright harness + config (serves built app on :3000)"
```

---

## Task 2: Auth + API seeding fixtures

**Files:** Create `e2e/fixtures/seed.ts`, `e2e/fixtures/test.ts`, `e2e/fixtures/assets/test-page.png`.

- [ ] **Step 1: Fixture image** — create `e2e/fixtures/assets/test-page.png`: a plain solid-color PNG of KNOWN dimensions (e.g. 1000×800). (Generate it however convenient — a tiny script or commit a static asset. It just needs to render as a project page so the canvas has something to draw on.)

- [ ] **Step 2: `seed.ts`** — API helpers using Playwright's `APIRequestContext`:
  - `login(request): Promise<{ token, user }>` → `POST /api/auth/login {username:'admin',password:'admin'}`.
  - `seedProjectWithPage(request, token, opts?): Promise<{ projectId, pageId, imageId }>`:
    - read `assets/test-page.png` → base64 data URL; `POST /api/images { id: imageId, data: dataUrl }`.
    - build a `Project` with one `ProjectPage` referencing `imageId` (imageWidth 1000, imageHeight 800, `measurements: []`, `scaleConfig: null` so the canvas spec calibrates it; or a preset scaleConfig for the takeoffs spec). `POST /api/projects` with the auth header.
    - return ids. (Match the exact Project/ProjectPage shape in `src/types.ts` — read it; include required fields like `createdAt`, `takeoffs: []`.)
  - `seedTakeoff(...)` optional helper to add a takeoff to a project (or do it via the UI in the takeoffs spec).

- [ ] **Step 3: `test.ts`** — extend Playwright's `test` with fixtures:
  - an `authedPage` fixture that logs in via API, then sets `localStorage.token`/`localStorage.user` before navigation (via `page.addInitScript` or a `storageState` built once in a setup project). Simplest: in the fixture, `await page.addInitScript(({t,u}) => { localStorage.setItem('token',t); localStorage.setItem('user',u); }, {...})` then it's authed on first nav.
  - a `seed` fixture exposing the seed helpers bound to a fresh `request` context + token.

- [ ] **Step 4:** A tiny `e2e/auth.spec.ts` (or fold into smoke): with `authedPage`, navigate to `/dashboard` and assert an authed-only element renders (not redirected to login). Run `npm run test:e2e` → green.

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures package.json
git commit -m "test(e2e): auth + API seeding fixtures (project + page + image)"
```

---

## Task 3: data-testid instrumentation for stable selectors

**Files:** small additive edits across the canvas/takeoff source.

Stable selectors keep E2E from coupling to styling/text. Add `data-testid` ONLY (no behavior/markup change).

- [ ] **Step 1:** Add `data-testid`s to the elements the specs will target. Locate each and add the attribute:
  - CanvasView: the drawing canvas/overlay container (`canvas-surface`), each tool button (`tool-pan`, `tool-length`, `tool-area`, `tool-count`, `tool-scale`), undo/redo (`btn-undo`/`btn-redo`), the right-sidebar container (`measurement-sidebar`), each measurement row (`measurement-row` + maybe a value sub-element `measurement-value`), the scale modal input/apply (the ScaleCalibrationModal — `scale-input`, `scale-apply`).
  - ProjectView Pages tab: the pages container (`pages-list`), a page card/row (`page-row`), the search input (`page-search`), view/sort toggles, the rename input.
  - ProjectView Takeoffs tab: the takeoffs table (`takeoffs-table`), a takeoff row (`takeoff-row`), the new-takeoff button (`btn-new-takeoff`), edit/delete buttons, the print/excel buttons (`btn-export-excel`, `btn-print`).
  - NewTakeoffModal + EditTakeoffModal: name input, save button.
  Use the ui components' existing props if they pass through `data-testid`; otherwise add the attribute to the rendered element.

- [ ] **Step 2:** `npx tsc --noEmit` clean; `npm test` green; `npm run build`. (Pure attribute additions — nothing else changes.)

- [ ] **Step 3: Commit**

```bash
git add src
git commit -m "test(e2e): add data-testid hooks to canvas/takeoff UI (no behavior change)"
```

---

## Task 4: ProjectView Pages tab spec

**Files:** Create `e2e/pages.spec.ts`.

- [ ] **Step 1:** With `authedPage` + a seeded project (1 page), navigate to `/project/:id/takeoff` (pages tab is default). Characterize:
  - the seeded page renders in `pages-list` (one `page-row`).
  - **search**: type a non-matching term in `page-search` → the page row hides; clear → it returns.
  - **view toggle**: switching grid/list view changes layout (assert a class or a structural marker) without losing the page.
  - **rename**: trigger inline rename on the page, type a new name, confirm → reload the page route → the new name persists (proves the save round-trips through the API).
  - **(light) add-pages open/close**: click Add Pages → the AddPagesModal opens (assert step-1 fields visible) → close → it dismisses. (Full upload flow is heavier; a deeper add-pages spec is optional/out-of-scope for critical path — note it.)

- [ ] **Step 2:** Run `npm run test:e2e e2e/pages.spec.ts` → green (iterate selectors as needed).

- [ ] **Step 3: Commit**

```bash
git add e2e/pages.spec.ts
git commit -m "test(e2e): characterize ProjectView pages tab (render/search/view/rename)"
```

---

## Task 5: ProjectView Takeoffs tab spec

**Files:** Create `e2e/takeoffs.spec.ts`.

- [ ] **Step 1:** With a seeded project, navigate to the takeoffs tab. Characterize:
  - **create**: click `btn-new-takeoff` → NewTakeoffModal → enter a name + pick a type/color → save → a `takeoff-row` appears in `takeoffs-table` with that name.
  - **edit**: open EditTakeoffModal for it → change name + set a simple cost-per-unit → save → the row reflects the change.
  - **advanced cost**: edit again → toggle advanced costing → add a custom-cost row (e.g. a flat cost) → save → no crash; reopen shows the custom cost persisted.
  - **delete**: delete the takeoff (confirm dialog) → the row disappears.
  - **totals**: with a takeoff that has a cost and (if feasible) a seeded measurement giving it a value, assert the table shows a non-zero total. (If wiring a measured value here is hard, assert the totals row renders and updates after edit; the precise cost integration is covered in the canvas spec.)

- [ ] **Step 2:** Run the spec → green.

- [ ] **Step 3: Commit**

```bash
git add e2e/takeoffs.spec.ts
git commit -m "test(e2e): characterize ProjectView takeoffs tab (create/edit/advanced-cost/delete/totals)"
```

---

## Task 6: CanvasView scale + drawing spec (the crown jewel)

**Files:** Create `e2e/canvas.spec.ts`.

This characterizes the highest-risk, highest-value pipeline. Use **self-referential** assertions so they don't depend on exact canvas pixel→image mapping or zoom.

- [ ] **Step 1: Setup** — seed a project + page with `scaleConfig: null`. Navigate to `/project/:id/page/:pageId`. Wait for `canvas-surface` to be visible and the page image loaded. Reset/ensure a known zoom if the app exposes one (or just rely on consistent coords within a single test). Define helper to click at a canvas-relative coordinate: get `canvas-surface` bounding box, then `page.mouse.click(box.x + dx, box.y + dy)`.

- [ ] **Step 2: Scale calibration** — select `tool-scale`; click two points P1=(200,200) and P2=(600,200) (a horizontal span of 400 screen px); the ScaleCalibrationModal opens; fill `scale-input` with `10` and unit `ft`; click `scale-apply`. (This sets: that 400px span = 10 ft.)

- [ ] **Step 3: Length measurement (proportional assertion)** — create/select a takeoff (via the canvas's new-measurement flow or a pre-seeded takeoff + select `tool-length`). Draw a length measurement clicking P1=(200,200) → P2=(400,200) (HALF the calibration span) → finish (double-click or Enter, whatever the app uses). Assert the measurement appears in `measurement-sidebar` and its displayed value ≈ **5 ft** (half of 10 ft) — use a tolerance (e.g. value parses to within ±0.2 ft, accounting for feet-inches formatting like `5' - 0"`). This proves clicks → pixel distance → scale ratio → displayed real value end-to-end. (math.ts is unit-tested; this asserts the integration.)

- [ ] **Step 4: Area measurement** — select `tool-area`; draw a rectangle by clicking 4 corners forming a span of (400px × 200px) which at 10ft/400px = 10ft × 5ft = **50 sq ft**; finish; assert the sidebar value ≈ 50 sq ft (tolerance). (Pick corner coords that yield a clean expected area given the calibration.)

- [ ] **Step 5: Count measurement** — select `tool-count`; click 3 distinct points; assert the count measurement reads **3** (each).

- [ ] **Step 6: Assign + edit + delete** — confirm a drawn measurement is associated with the selected takeoff (its row shows under/with the takeoff, or the takeoff total now reflects it); edit a measurement's name via `MeasurementItem`; delete a measurement (confirm dialog) → it leaves the sidebar.

- [ ] **Step 7: Undo/redo** — draw a measurement, click `btn-undo` → it disappears; `btn-redo` → it returns. (Characterize whatever the current undo/redo actually does — if it behaves a specific way, lock THAT in.)

- [ ] **Step 8:** Run `npm run test:e2e e2e/canvas.spec.ts` → green. Expect to iterate on coordinates / finish-gesture / selectors. If a specific interaction is too flaky to assert reliably (e.g. exact double-click-to-finish timing), use the app's actual finish affordance (a "finish"/checkmark button if one exists — prefer an explicit click over a gesture) and add a `data-testid` for it in Task 3 (loop back if needed). Document any interaction that couldn't be made deterministic.

- [ ] **Step 9: Commit**

```bash
git add e2e/canvas.spec.ts
git commit -m "test(e2e): characterize canvas scale calibration + length/area/count drawing pipeline"
```

---

## Task 7: Export spec + README + verification + push

**Files:** Create `e2e/export.spec.ts`, `e2e/README.md`.

- [ ] **Step 1: Export spec** — with a project that has a takeoff + at least one measurement: on the takeoffs tab, click `btn-export-excel` and assert a **download** occurs (Playwright `page.waitForEvent('download')`, check `suggestedFilename()` ends `.xlsx`). For the proposal/print path: trigger Print → it generates a printout → assert it appears (navigate to `/project/:id/proposal` and assert the printout history grew by one, since 5b routed Print output there). Do NOT assert PDF/Excel binary content (out of scope) — assert the integration (download happens / printout recorded).

- [ ] **Step 2: README** — `e2e/README.md`: how to run (`npm run test:e2e`, `:ui`), that it builds + boots the server on :3000 with a throwaway `.e2e-data` DB, the self-referential canvas-coordinate approach, and that it's separate from `npm test`.

- [ ] **Step 3: Full verification** — `npm run lint` clean; `npm test` (unit, 352) green; `npm run build` succeeds; `npm run test:e2e` → ALL e2e specs green (run the whole suite, confirm no cross-spec state bleed since workers:1 and seeding is per-test). If any spec is flaky across 3 consecutive runs, stabilize it (better waits/selectors) before proceeding — a flaky characterization test is worse than none.

- [ ] **Step 4: Push.** (Pure test infra + testid additions; no app behavior change.)

```bash
git add e2e/export.spec.ts e2e/README.md
git commit -m "test(e2e): export download spec + e2e README"
git push origin testing
```

- [ ] **Step 5: Memory** — record the E2E pass shipped: Playwright suite characterizing the deferred core (pages tab, takeoffs tab, canvas scale+drawing pipeline, exports); how it runs; the self-referential canvas approach. Note this is the SAFETY NET that unblocks the deferred-core decomposition (a future "5g" pass can now extract the pages grid / takeoffs table / drawing engine with these E2E tests catching regressions). Flag any interaction that couldn't be made deterministic (left uncovered).

---

## Self-Review Notes (author)

- **Why Playwright + single-origin server:** the canvas/PDF rendering (pdf.js + worker) needs a real browser; serving the built app via `tsx server.ts` gives one origin (no proxy) and exercises the real production serving path. A throwaway `.e2e-data` DB keeps runs hermetic; a fresh DB bootstraps admin/admin.
- **Determinism strategy:** canvas assertions are SELF-REFERENTIAL (calibrate a span, then measure fractions of it) so they hold regardless of the exact screen→image scale or zoom — the fragile part of canvas E2E. Fixed viewport + bounding-box-relative clicks keep coordinates stable. Prefer explicit finish/confirm affordances over timing-sensitive gestures (add testids for them).
- **Characterization, not aspiration:** these lock in what the core does TODAY (per spec §8), including any quirks — so the later decomposition (extract pages grid / takeoffs table / drawing engine into modules) is guarded. Surprising-but-current behavior gets asserted, not "fixed."
- **Boundaries:** no app behavior changes (only `data-testid` additions + tests). E2E is a separate runner, excluded from `npm test`. Binary PDF/Excel content is not asserted (download + printout-recorded is the integration signal). Comprehensive interactions (favorites, context menus, multi-select, revisions/compare, collaboration cursors, full add-pages upload, retry-failed) are deferred — note them as uncovered.
- **Payoff:** once green + stable, this is the prerequisite that makes the deferred stateful-core decomposition safe to attempt.
