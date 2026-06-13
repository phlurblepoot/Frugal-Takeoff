# Phase 6 — Migration & Cutover Safety Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the safety rails for the one-time production cutover (spec §9): a full-`data/` backup+restore CLI, a migration verification tool (integrity checks), a pre-flight manifest tool (pre/post entity counts), and a documented cutover runbook. The actual data migration already exists (migrations 2/4/5/11 transform the old DB in place on boot) — Phase 6 adds the verification + backup + procedure around it.

**CRITICAL — supervised boundary:** Phase 6 does NOT run any migration on production or real testing-branch data. Per the standing protocol (Nathan watches data migrations) and spec §9 ("tested first on the testing-branch data with Nathan observing, then production cutover"), the OBSERVED dry-run and the production cutover are SUPERVISED operations Nathan runs using this tooling + runbook. This plan delivers the tools/docs and STOPS there. All tooling is tested against synthetic/temp data dirs only.

**Architecture:** Node/tsx CLI scripts under `scripts/`, wired as npm scripts, reusing the server's db + fileStore modules. Vitest (server project) tests them against synthetic data dirs. No changes to the app runtime or the migrations themselves.

**Tech Stack:** tsx, better-sqlite3, the existing `server/db.ts`/`server/migrations.ts`/`server/migrationList.ts`/`server/fileStore.ts`/`server/files.ts`. Vitest server project.

**Key facts (from the Phase 6 explore):**
- Migration runner `server/migrations.ts`: applies pending migrations in transactions, backs up the DB file to `<STORAGE_PATH>/backups/app-v<from>-<ts>.db` BEFORE applying (DB file only, NOT files/), VACUUMs after. Called from `server.ts:70` with `{ dbFile, vacuum: true }`.
- Importer = migrations: 2 (legacy JSON-dir/base64 import), 4 (images table → disk files, computes+stores sha256), 5 (decompose monolithic projects.data → normalized projects/plan_sets/takeoffs/pages/measurements + label files), 11 (checklists → tasks). In-place on the same `app.db`.
- Files on disk: `data/files/<shard>/<id>` (shard = first 2 sanitized chars); `fileStore.writeFileContent` computes sha256; `files` table has `id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt`.
- Latest schema version = 11. Normalized projects have `data = NULL`. The `images` table is dropped by migration 4.
- Deploy: Docker, `STORAGE_PATH=/app/data` (Unraid host dir mounted), `data/` = `app.db` + `files/` + `backups/`.
- Tables to count/verify: projects, plan_sets, pages, measurements, takeoffs, files, issues, issue_photos, invoices, invoice_lines, payments, change_orders, punch_items, punch_photos, tasks, task_photos, notes, time_entries, users, shares, drafts, checklists(legacy backup). (Confirm the exact set from migrationList.ts.)

---

## File Structure

**Create:**
- `scripts/backup-data.ts` — snapshot the whole `data/` dir → timestamped archive
- `scripts/restore-data.ts` — restore `data/` from a snapshot (with guard)
- `scripts/migrate-manifest.ts` — capture entity counts from a source data dir → manifest JSON
- `scripts/verify-migration.ts` — integrity checks against a migrated data dir → PASS/FAIL report
- `scripts/lib/dataStats.ts` — shared: open a db read-only, count tables, list files, hash-check (reused by manifest + verify + tests)
- `scripts/*.test.ts` — vitest tests for the lib + scripts against synthetic data dirs
- `docs/MIGRATION-CUTOVER.md` — the runbook

**Modify:**
- `package.json` — add `backup`, `restore`, `migrate:manifest`, `migrate:verify` scripts
- `vitest.config.ts` — ensure `scripts/**/*.test.ts` are in the server (node) project's include (NOT the ui/jsdom project)

---

## Task 1: Full-data backup + restore CLI

**Files:** Create `scripts/backup-data.ts`, `scripts/restore-data.ts`; modify `package.json`.

The framework backs up only `app.db`; the cutover needs the WHOLE `data/` (db + files/).

- [ ] **Step 1: `scripts/backup-data.ts`** — reads `STORAGE_PATH` (default `./data`), creates a timestamped backup of the entire dir EXCLUDING the existing `backups/` subdir (don't recursively nest backups). Output: either a `.tar.gz` (use node's `zlib` + `tar` — or, simplest and dependency-free, recursively copy to `<dest>/full-backup-<ts>/` and print the path). Prefer a recursive copy to a sibling dir `<STORAGE_PATH>/../ft-backups/full-<ISO-ts>/` (or a `--dest` arg) so it works without adding a tar dep. Print the absolute path + a summary (db size, file count, total bytes). Exit non-zero on any error (fail loud).

- [ ] **Step 2: `scripts/restore-data.ts`** — takes a `--from <backup-dir>` arg and a target `STORAGE_PATH`; GUARD: refuse to overwrite a non-empty target unless `--force` is passed (print a clear warning). Copies the backup back into place. Print what it restored. This is the rollback tool.

- [ ] **Step 3: package.json scripts** — `"backup": "tsx scripts/backup-data.ts"`, `"restore": "tsx scripts/restore-data.ts"`.

- [ ] **Step 4: Test** `scripts/backup-data.test.ts` (vitest, server project): build a synthetic data dir (a tiny `app.db` + a couple `files/<shard>/<id>` + a `backups/` subdir), run the backup function, assert the snapshot contains the db + files but NOT the nested `backups/`; run restore into a fresh dir, assert byte-identical files + db. Use temp dirs (os.tmpdir()).

- [ ] **Step 5: Verify** — `npx tsc --noEmit` clean; `npm test` green (new tests included); `npm run backup` against a throwaway `STORAGE_PATH=/tmp/ft-bktest` (seed it first) prints a path.

- [ ] **Step 6: Commit**

```bash
git add scripts/backup-data.ts scripts/restore-data.ts scripts/backup-data.test.ts package.json vitest.config.ts
git commit -m "feat(ops): full data/ backup + restore CLI for cutover"
```

---

## Task 2: Pre-flight manifest tool

**Files:** Create `scripts/lib/dataStats.ts`, `scripts/migrate-manifest.ts` (+ test); modify `package.json`.

Captures counts from a SOURCE (old) data dir BEFORE cutover, so the post-migration verify can compare old↔new.

- [ ] **Step 1: `scripts/lib/dataStats.ts`** — shared helpers (read-only):
  - `openReadOnly(dbFile): Database` — open better-sqlite3 readonly.
  - `tableExists(db, name): boolean`, `count(db, table): number` (guard missing tables → 0).
  - `legacyCounts(dataDir)`: detect + count the OLD shapes — legacy JSON dirs (`data/projects/*.json`, `data/images/*.txt`) if present, AND/OR pre-normalization sqlite (`projects` rows where `data` not null, `images` table rows, `checklists` rows, `time_entries`, `templates`, `notes`, `users`). Return a record of whatever it finds (a source may be JSON-dir OR sqlite OR mid-migration).
  - `newCounts(db)`: counts of the normalized tables (projects, plan_sets, pages, measurements, takeoffs, files, issues, invoices, payments, change_orders, punch_items, punch_photos, tasks, task_photos, notes, time_entries, users, shares).
  - `listFiles(db)`: `[{id, sha256, size, path}]` from the `files` table + computed disk path via fileStore.pathFor.

- [ ] **Step 2: `scripts/migrate-manifest.ts`** — reads `STORAGE_PATH` (or `--data <dir>`); writes `<dataDir>/migration-manifest.json` with `{ capturedAt, schemaVersion (if sqlite), legacyCounts, newCounts (if already migrated) }`. Print a human summary table. This is run on a COPY of the source before migration.

- [ ] **Step 3: package.json** — `"migrate:manifest": "tsx scripts/migrate-manifest.ts"`.

- [ ] **Step 4: Test** `scripts/migrate-manifest.test.ts`: build a synthetic OLD-ish data dir (a sqlite with a couple legacy `projects.data` blobs + an `images` table + a `checklists` row) and assert legacyCounts reports the right numbers; build a migrated dir and assert newCounts. Cover the missing-table guards.

- [ ] **Step 5: Verify** — tsc clean; `npm test` green.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/dataStats.ts scripts/migrate-manifest.ts scripts/migrate-manifest.test.ts package.json
git commit -m "feat(ops): pre-flight migration manifest (entity counts)"
```

---

## Task 3: Migration verification tool (the core deliverable)

**Files:** Create `scripts/verify-migration.ts` (+ test); modify `package.json`.

Runs AFTER migration against the migrated data dir. Self-consistent checks (don't need the old DB) + optional manifest compare. Outputs a clear PASS/FAIL report and exits non-zero on any failure.

- [ ] **Step 1: `scripts/verify-migration.ts`** — reads `STORAGE_PATH` (or `--data <dir>`), opens the migrated `app.db` read-only via dataStats, and runs CHECKS, each reported PASS/FAIL with details:
  1. **Schema version** = latest (read the max migration version from migrationList, assert `schema_version` MAX == it). Migrations fully applied.
  2. **Normalization complete**: zero `projects` rows with non-null `data`; the legacy `images` table does NOT exist (dropped by migration 4).
  3. **File-on-disk integrity** (the critical data-loss check): for every `files` row, resolve the disk path (fileStore.pathFor), assert the file EXISTS, its size matches `files.size`, and (for a sample by default, or `--full` for all) recompute sha256 and assert == `files.sha256`. Report every missing/size-mismatch/hash-mismatch file. (Default: hash ALL files unless there are >N; expose `--full`/`--sample N`.)
  4. **FK integrity**: every measurement → its page exists; every page → its project exists; takeoffs/issues/invoices/punch_items/tasks → valid parent project (or list); invoice_lines→invoice, payments→invoice, change_orders→project; issue_photos→issue, punch_photos→punch_item, task_photos→task; photo `fileId`s → exist in `files` (warn, since some legacy photos may predate the files table — report count, don't necessarily fail). Report counts of any broken refs.
  5. **Orphan files**: `files` with a non-null projectId pointing at a missing project — report count (warn).
  6. **Entity counts**: print the full `newCounts` table (for human eyeball / comparison).
  7. **Optional manifest compare** (`--manifest <path>` or auto-detect `migration-manifest.json`): compare key legacy counts → new counts where a 1:1 mapping is expected (e.g. legacy project count == new project count; legacy image count == new files count of kind that came from images; legacy checklist ITEM count == tasks count). Where a clean mapping exists, FAIL on mismatch; where it's fuzzy, WARN. Document the mappings in comments.
  - Exit 0 only if all hard checks PASS; non-zero otherwise. Clear final summary: "VERIFICATION PASSED/FAILED — X passed, Y warnings, Z failures."

- [ ] **Step 2: package.json** — `"migrate:verify": "tsx scripts/verify-migration.ts"`.

- [ ] **Step 3: Test** `scripts/verify-migration.test.ts`: 
  - Build a CLEAN migrated db (run the real migrations on a synthetic seeded db via the migration runner, write a couple of files to disk with correct sha256) → assert verify PASSES.
  - Build BROKEN cases and assert verify FAILS each: a files row whose disk file is missing; a files row with a wrong sha256 on disk; a measurement with a dangling pageId; a project still holding non-null `data`. Each should produce a FAIL with a clear message + non-zero exit.

- [ ] **Step 4: Verify** — tsc clean; `npm test` green.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-migration.ts scripts/verify-migration.test.ts package.json
git commit -m "feat(ops): migration verification tool (schema/files/FK/orphans/counts)"
```

---

## Task 4: Cutover runbook

**Files:** Create `docs/MIGRATION-CUTOVER.md`.

- [ ] **Step 1: Write the runbook** — the SUPERVISED procedure (Nathan runs it; reference the tools from T1-T3):
  - **Preconditions**: testing branch green (lint/test/build/e2e), production still on the OLD app, low-traffic window.
  - **0. Snapshot production**: `npm run backup` (or copy `data/`) → an off-box copy. This is the ground-truth rollback.
  - **1. Capture manifest on a COPY**: copy prod `data/` to a scratch dir; `STORAGE_PATH=<scratch> npm run migrate:manifest` → records legacy counts (BEFORE any migration).
  - **2. Dry-run on the copy (Nathan observing)**: point the NEW app at the scratch `data/` (`STORAGE_PATH=<scratch>`), boot it — migrations 2-11 run + auto-backup the db + VACUUM. Watch the logs (`[migrations] applied N: ...`).
  - **3. Verify the copy**: `STORAGE_PATH=<scratch> npm run migrate:verify --manifest <scratch>/migration-manifest.json` → must PASS. Review counts/warnings with Nathan. Smoke the new app on the scratch data in a browser (open a few projects, pages render, takeoffs/measurements intact, files/images load, issues/invoices/tasks present).
  - **4. Go/No-Go**: only proceed if verify PASS + browser smoke good. Document sign-off.
  - **5. Production cutover**: stop the old app; final `npm run backup` of live prod `data/`; start the NEW app pointed at prod `data/` (it auto-backs-up the db, runs migrations, VACUUMs); run `npm run migrate:verify` on prod; browser smoke.
  - **6. Rollback**: if verify FAILS or smoke is bad → stop new app, `npm run restore --from <the pre-cutover backup> --force`, restart the OLD app. (The new app also left `data/backups/app-v<from>-<ts>.db` — note it, but the full-data backup from step 0/5 is the authoritative rollback since files/ may have changed.)
  - **7. Post-cutover**: keep the backups for N days; monitor; note migration 11 transformed checklists→tasks (verify they look right).
  - Include the exact commands, the STORAGE_PATH for the Unraid container, and a checklist with checkboxes.

- [ ] **Step 2: Commit**

```bash
git add docs/MIGRATION-CUTOVER.md
git commit -m "docs(ops): production migration cutover runbook"
```

---

## Task 5: Full verification + push + handoff

- [ ] **Step 1: Full gate** — `npm run lint && npm test && npm run build` green. (E2E unaffected; optionally run it.) Sanity-run each new CLI against a throwaway seeded `STORAGE_PATH` to confirm they execute (backup prints a path; manifest writes json; verify prints PASS on a clean migrated dir).

- [ ] **Step 2: Final review** — dispatch a code-review subagent (sonnet) over the Phase 6 range. Focus: (1) the verify tool's checks are correct + meaningful (file-hash integrity actually reads disk + recomputes; FK checks query the right columns; schema-version check uses the real latest version; exit codes correct); (2) backup/restore don't nest backups + the restore guard prevents accidental clobber; (3) all scripts open the db READ-ONLY (never mutate prod data); (4) tests cover the broken cases (verify FAILS on missing/corrupt file, dangling FK, un-normalized project); (5) the runbook's commands match the actual script args + the rollback is sound. Fix Critical/Important.

- [ ] **Step 3: Push**

```bash
git push origin testing
```

- [ ] **Step 4: Memory + HANDOFF** — record Phase 6 tooling shipped (backup/restore, manifest, verify, runbook). **Do NOT mark the production cutover done** — record that the cutover itself is a SUPERVISED operation pending with Nathan (per protocol), to be run via `docs/MIGRATION-CUTOVER.md`. Then present Nathan with the handoff: the tools exist, the runbook is ready, and the next step is the observed dry-run on a copy of his data (which HE runs with me observing) — explicitly ask before any real-data migration.

---

## Self-Review Notes (author)

- **The importer already exists** (migrations 2/4/5/11) — Phase 6 adds ONLY safety rails (backup/restore, manifest, verify, runbook). No new import code, no migration changes.
- **Read-only by construction**: all Phase 6 scripts open the DB read-only and never mutate the data dir except backup-data (writes a copy) / restore-data (explicit, guarded). They cannot corrupt prod.
- **Supervised boundary respected**: NO real-data or production migration is run in this phase. Tooling is tested against synthetic temp dirs. The observed dry-run + cutover are Nathan's supervised steps (protocol + spec §9), gated by an explicit ask.
- **The verify tool is the core value**: on-disk file-hash integrity is the real data-loss guard (proves every `files` row's bytes survived the images→disk move); FK/orphan/normalization checks prove the decompose was clean. Manifest compare adds before/after count assurance for the supervised run.
- **Rollback is the full-data backup** (step 0/5), not just the framework's db-only backup, because the images→disk migration mutates `files/` too.
