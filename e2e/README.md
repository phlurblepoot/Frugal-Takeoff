# End-to-end tests (Playwright)

These are browser-driven, full-stack characterization tests. They build the real
app, boot the real server against a throwaway SQLite database, and drive the SPA
in a real Chromium browser. They are **separate from `npm test`** (the Vitest
unit suite) and do not run as part of it.

## Running

```bash
npm run test:e2e          # headless, full e2e suite
npm run test:e2e:ui       # Playwright UI mode (pick/replay tests interactively)
npm run test:e2e e2e/export.spec.ts   # a single spec
```

Both scripts `rm -rf .e2e-data` first, so every run starts from a clean DB.

## How it works

- **App build + server boot.** Playwright's `webServer` runs
  `npm run build && STORAGE_PATH=.e2e-data PORT=3000 npx tsx server.ts`
  (see `playwright.config.ts`). It compiles the production client and serves it
  plus the API from `tsx server.ts` on **http://localhost:3000**.
- **Throwaway database.** `STORAGE_PATH=.e2e-data` points the server at a
  disposable `.e2e-data` SQLite DB. The npm scripts wipe `.e2e-data` before each
  run, so tests never see data from a previous run (or from your dev DB). Boot
  also runs migrations against this fresh DB.
- **Auth.** Tests log in as the bootstrap `admin` / `admin` user via
  `POST /api/auth/login` (`fixtures/seed.ts`). The `authedPage` fixture seeds
  `localStorage.token` + `localStorage.user` via an init script that runs
  **before** first paint, so the SPA loads authed routes without bouncing to
  `/login`.
- **Seeding via the API.** Specs seed fresh projects (random ids per test, to
  avoid cross-test bleed on the shared server/DB) through the REST API rather
  than the UI: `seedProjectWithPage` (a project + one raster page) and
  `seedProjectWithTakeoffMeasurement` (adds one takeoff + one length measurement
  wired to it — the minimum shape the Print/highlights path needs).
- **Self-referential canvas coordinates.** The canvas spec does not hard-code
  device pixels. It **calibrates** the page→screen mapping from the rendered
  canvas itself (read the on-screen geometry, set the scale by clicking known
  points), then **measures** in that same self-derived coordinate space. This
  keeps the canvas assertions stable across viewport/DPR differences instead of
  depending on magic pixel offsets.
- **Serial, single worker.** `fullyParallel: false`, `workers: 1` — the suite
  shares one server/DB, so tests run one at a time.

## One-time system requirement (Chromium)

Chromium needs a few system libraries (`libnspr4`, `libnss3`, `libasound2t64`).
Install them once with:

```bash
npx playwright install-deps chromium
# (and, if the browser binary itself is missing)
npx playwright install chromium
```

## What's covered

- **Smoke** — app boots, authed routes load.
- **Auth** — login / redirect behavior.
- **Pages tab** — page list / page section behavior.
- **Takeoffs tab** — create / edit / delete a takeoff, advanced-cost toggle
  persistence.
- **Canvas** — calibrate scale, then draw a measurement (self-referential
  coordinates).
- **Exports** — Takeoffs-tab Print and Excel. Both buttons only render once a
  takeoff is selected; both persist a **printout** server-side and navigate to
  the Proposal section (they do **not** trigger a browser download — that lives
  on the Proposal section's per-printout Download button). The specs assert the
  resulting Excel/PDF printout appears in the Proposal "Printout history"; they
  do **not** assert on workbook/PDF binary content.

## What's intentionally NOT covered

Favorites, page/takeoff context menus, multi-select, revisions / compare,
collaboration cursors, the full add-pages upload flow, and retry-failed.
