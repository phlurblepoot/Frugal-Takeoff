# Production Migration Cutover — RUNBOOK

A supervised, one-time procedure to migrate production from the **OLD** app to
the **NEW** rebuilt app. Nathan runs each command; the agent observes and
reviews output at every gate.

---

## Overview

- **What this does.** The NEW app *is* its own migrator. When it boots pointed
  at the OLD `app.db`, the migration framework (`server/migrations.ts`) runs
  migrations **1 → 11** (`server/migrationList.ts`) which transform the database
  **in place**: legacy JSON/base64 import, images → on-disk files with sha256,
  decompose the monolithic `projects.data` blob into normalized tables, and
  checklists → tasks. There is no separate import step — **booting the new app
  on the old data dir performs the migration.**
- **Automatic safety net.** Before applying any pending migration, the framework
  copies the DB to `<STORAGE_PATH>/backups/app-v<from>-<timestamp>.db`, then
  **VACUUM**s the DB after migrations finish. This auto-backup is **DB-only** —
  it does NOT cover the `files/` dir that the images→disk migration writes.
- **This is a SUPERVISED, one-time op.** Nathan executes; the agent watches logs
  and reviews verifier output. Do not automate it.
- **It is reversible.** The authoritative rollback is the **full-data backup**
  taken in Step 0 / Step 4 (`npm run backup`), which captures `app.db` **and**
  `files/`. Restore with `npm run restore`.
- **Latest schema version: `32`.** The verifier derives the expected version
  from `server/migrationList.ts` (`LATEST_SCHEMA_VERSION`) and asserts the DB
  reached it, so it stays correct as migrations are added.

### Deployment shape (from `docker-compose.yml` / `Dockerfile`)

- Service: **`app`** (container name `plan-takeoff-app`), built from the local
  `Dockerfile`, listening on `3000:3000`.
- Volume mount: **`./data:/app/data`** — host `data/` is the live data volume.
- Env: `STORAGE_PATH=/app/data`, `NODE_ENV=production`.
- Startup command: `npx tsx server.ts`.
- Production runs on an **Unraid** container; the host `data/` dir lives on the
  Unraid volume mapped into the container at `/app/data`. It contains:
  `app.db`, `files/`, and `backups/`.

### Flag convention (verified against the scripts)

All Phase 6 tools are npm scripts that pass through extra args after `--`, and
each parses `--flag value` (space-separated, **not** `=`). Examples:

```bash
npm run backup -- --data ./data --dest ./ft-backups/full-XXXX
npm run restore -- --from <backup-dir> --data ./data --force
npm run migrate:manifest -- --data ./data
npm run migrate:verify -- --data ./data --manifest ./data/migration-manifest.json
```

`STORAGE_PATH` is honored by every script as the default data dir when `--data`
is omitted.

---

## Preconditions (check all before starting)

- [ ] `testing` branch is green: `npm run lint`, `npm run test`, `npm run build`,
      `npm run test:e2e` all pass.
- [ ] The NEW app image builds cleanly (`docker compose build app`).
- [ ] A low-traffic / scheduled-downtime window is agreed and announced.
- [ ] Host/SSH access to the Unraid box and its `data/` volume is confirmed.
- [ ] Free disk space ≥ **2× the current `data/` size** (room for the off-box
      full copy *and* the scratch copy + its auto-backup).
- [ ] This runbook is open and the agent is observing.

---

## Step 0 — Snapshot production (ground-truth rollback)

Take an authoritative, off-box full copy of live prod `data/` (`app.db` +
`files/`). This is the rollback of last resort and is taken **before anything
else touches prod**.

- [ ] Make the full-data backup (excludes the redundant nested `backups/`):

  ```bash
  # On the Unraid host, from the app repo dir. <prod-data> is the host path
  # mounted into the container at /app/data (e.g. /mnt/user/appdata/plan-takeoff/data).
  npm run backup -- --data <prod-data> --dest /mnt/user/backups/ft-cutover/step0-prod
  ```

  - [ ] Note the printed `destination:`, `app.db` bytes, and `files/` count.

- [ ] **Alternative / belt-and-suspenders** manual copy (preserves perms/links):

  ```bash
  cp -a <prod-data> /mnt/user/backups/ft-cutover/step0-prod-cp
  ```

- [ ] Confirm the Step 0 backup exists, is non-empty, and is **on a different
      disk / off the box**. Record its path here: `____________________`.

> **Do not proceed without a verified Step 0 backup.**

---

## Step 1 — Dry run on a COPY (do NOT touch prod)

We migrate a throwaway copy first. Prod stays untouched and serving.

- [ ] Copy prod `data/` to a scratch dir:

  ```bash
  cp -a <prod-data> /mnt/user/backups/ft-cutover/scratch
  ```

- [ ] Capture the **pre-migration manifest** on the scratch copy (read-only;
      writes only `migration-manifest.json` into the dir):

  ```bash
  STORAGE_PATH=/mnt/user/backups/ft-cutover/scratch npm run migrate:manifest
  ```

  - [ ] Review printed `schemaVersion` (expected low/`(none)` for old data),
        **Legacy counts**, and **New (normalized) counts**. Eyeball that legacy
        project / checklist / image counts look like prod.

- [ ] Boot the NEW app against the scratch dir so migrations run. Either:

  **Option A — quick local run (recommended for the dry run):**

  ```bash
  STORAGE_PATH=/mnt/user/backups/ft-cutover/scratch npx tsx server.ts
  ```

  **Option B — via docker-compose** (temporarily point the `app` volume at the
  scratch dir, e.g. with an override file, then):

  ```bash
  docker compose up app
  ```

- [ ] Watch the logs for the full migration chain, in order:

  - [ ] `[migrations] backed up database to .../backups/app-v<from>-<ts>.db`
  - [ ] `[migrations] applied 1: base-schema` … through …
        `[migrations] applied 11: tasks` (each version 1→11 should appear; some
        may be skipped if already applied on this copy)
  - [ ] `[migrations] compacting database (VACUUM)...`
  - [ ] `[migrations] database compacted`

- [ ] Once migrations complete and the server is up, **stop the app**
      (`Ctrl-C` for Option A, or `docker compose down` for Option B).

> If the migration **throws / a transaction fails**, STOP. The scratch DB is
> disposable; investigate, fix forward on `testing`, then re-copy prod and
> re-run Step 1. Prod has not been touched.

---

## Step 2 — Verify the COPY (Nathan + agent review)

- [ ] Run the verifier against the migrated scratch dir, using the Step 1
      manifest for count reconciliation:

  ```bash
  STORAGE_PATH=/mnt/user/backups/ft-cutover/scratch npm run migrate:verify -- \
    --manifest /mnt/user/backups/ft-cutover/scratch/migration-manifest.json
  ```

  - [ ] Output ends with **`VERIFICATION PASSED`** and the command exits `0`.
  - [ ] Review each check line:
    - `schemaVersion` → pass at **11**
    - `normalizationComplete` → all projects decomposed, legacy `images` dropped
    - `fileIntegrity` → all files intact (size + sha256). **This is the critical
      data-loss guard.** By default it hashes **every** file (size + existence
      are always checked for all); pass `--sample N` only to limit hashing on a
      huge dataset.
    - `fkIntegrity` → all structural relations resolve
    - `manifestCompare` → `projects` and `tasks` counts reconcile 1:1
    - `photoFilesExist`, `orphanFiles` → **WARN is acceptable** (legacy photos
      may predate the files table); review but they do not fail the run.

- [ ] **Browser smoke on the scratch data.** Boot the new app against the
      scratch dir again (`STORAGE_PATH=...scratch npx tsx server.ts`) and check:
  - [ ] Open several projects — pages render, takeoffs/measurements intact.
  - [ ] Plan images / page thumbnails load (proves files→disk migration).
  - [ ] Issues list + an issue's photos load.
  - [ ] Invoices / Payments / Change Orders present on a billed project.
  - [ ] Tasks (from checklists) present.
  - [ ] Punch list + punch photos present.
  - [ ] Open the **Proposal** section of a project.
  - [ ] Stop the app when done.

---

## Step 3 — Go / No-Go gate

- [ ] **GO** only if: verify printed `VERIFICATION PASSED` (exit 0) **AND**
      browser smoke looked correct.
- [ ] Record sign-off — who and when: `_______________  @  ____________`.

> **NO-GO:** STOP the cutover. Fix forward on `testing`, rebuild the image,
> re-copy prod, and repeat Steps 1–2. Prod remains on the OLD app, untouched.

---

## Step 4 — Production cutover

Only after a recorded GO.

- [ ] Announce downtime has started.
- [ ] Stop the OLD app container:

  ```bash
  docker compose down            # or: docker stop plan-takeoff-app
  ```

- [ ] Take a **final full-data backup** of live prod (captures anything written
      since Step 0):

  ```bash
  npm run backup -- --data <prod-data> --dest /mnt/user/backups/ft-cutover/step4-final
  ```

  - [ ] Record the destination path: `____________________`. **This is the
        rollback source for Step 5.**

- [ ] (Optional but recommended) capture a fresh manifest of the live prod data
      for post-migration reconciliation:

  ```bash
  npm run migrate:manifest -- --data <prod-data> \
    --out /mnt/user/backups/ft-cutover/prod-manifest.json
  ```

- [ ] Point the NEW app's compose volume at prod `data/` (the default
      `./data:/app/data` mapping already does this if the repo's `data/` is the
      prod volume) and start it — migrations auto-run on this real data:

  ```bash
  docker compose up -d app
  docker compose logs -f app
  ```

- [ ] Watch the same log sequence as Step 1:
      `backed up database to .../backups/app-v<from>-<ts>.db` →
      `applied 1..11` → `compacting database (VACUUM)...` → `database compacted`.

- [ ] Verify the migrated production data:

  ```bash
  npm run migrate:verify -- --data <prod-data> \
    --manifest /mnt/user/backups/ft-cutover/prod-manifest.json
  ```

  - [ ] Must print **`VERIFICATION PASSED`** (exit 0). If it FAILS → go to
        **Step 5 (Rollback)** immediately.

- [ ] **Browser smoke on production** — repeat the Step 2 checklist against the
      live app (projects, images, issues/photos, invoices, tasks, punch,
      proposal).

- [ ] If verify PASSED and smoke is clean → cutover succeeded. Announce that the
      app is back up. Proceed to **Step 6**.

---

## Step 5 — Rollback (only if Step 4 verify FAILS or smoke is bad)

The authoritative rollback uses the **Step 4 full-data backup** because it
restores `files/` too — the `data/backups/app-v*.db` auto-backup is **DB-only**
and would leave the disk `files/` in the migrated (mutated) state.

- [ ] Stop the new app:

  ```bash
  docker compose down
  ```

- [ ] Restore the full-data backup over prod (`--force` required — target is
      non-empty):

  ```bash
  npm run restore -- --from /mnt/user/backups/ft-cutover/step4-final \
    --data <prod-data> --force
  ```

  - [ ] Review the printed `app.db` bytes + `files/` count vs. what Step 4 backed
        up.

- [ ] Restart the **OLD** app (the OLD image/compose config) against the restored
      `data/`.
- [ ] Confirm prod is back to the OLD app and serving correctly (browser check).
- [ ] Announce service restored. Preserve all backups + logs for the post-mortem,
      then fix forward on `testing` before re-attempting.

---

## Step 6 — Post-cutover

- [ ] Keep **all** backups (Step 0, Step 4, and the in-volume
      `data/backups/app-v*.db`) for at least **14 days**.
- [ ] Monitor app logs and error rates over the first business day.
- [ ] Spot-check migration **11 (`tasks`)**: a few projects' checklist → task
      conversions look right. (The legacy `checklists` table is retained as a
      backup inside the DB, so source data is recoverable for comparison.)
- [ ] Review any verifier **WARN**s (photo gaps / orphan files) and decide
      whether cleanup is warranted.
- [ ] Decommission the OLD app image/container once confident (after the backup
      retention window).

---

## Mail (migrations 31–32)

The mail client replaces the old per-user SMTP config with real mail accounts.
Treat this pull as **supervised** — migration 31 transforms data.

**What the migrations do**

- **31 `mail-client`** — creates the `mail_*` tables and adds three `rfis`
  columns (all additive), then **transforms** each user's stored `smtp.*`
  preferences into a mail account: provider `imap`, IMAP host guessed from the
  SMTP host (port 993, TLS), the SMTP half copied verbatim, credentials sealed
  with the mail key, status **`needs_review`**. The `smtp.*` preference rows are
  then **deleted** for that user. A half-filled config — `smtp.host` set but no
  `smtp.fromAddress` and no `smtp.username` — is **left untouched** (the prefs
  are the only copy of it) and logged as
  `[migration 31] user <id>: smtp.host set but no fromAddress/username — left untouched`.
- **32** — adds `idx_mail_messages_acct_pthread`. Index only, no data change.

**Before the pull**

- [ ] Full backup as in Step 0 (`npm run backup`) — the transform deletes
      preference rows.
- [ ] Note who currently has SMTP configured, so the account list can be checked
      against it afterwards:
      `sqlite3 <prod-data>/app.db "SELECT userId FROM user_preferences WHERE key='smtp.host' AND TRIM(value)<>'';"`

**After the pull**

- [ ] Read the boot log for `[migration 31]` lines. `mailCrypto not supplied —
      smtp.* transform skipped` must **not** appear (the server always supplies
      it; seeing it means the key file could not be loaded). Any
      `left untouched` line names a user whose SMTP config needs re-entering by
      hand.
- [ ] Confirm `<prod-data>/mail.key` exists, is `0600`, and is included in the
      next backup. **It is generated on first start and must travel with the
      data directory** — `app.db` alone cannot decrypt a single stored token or
      IMAP password. Losing it costs no data: every user simply reconnects.
      Setting `MAIL_SECRET_KEY` in the environment overrides the file entirely.
- [ ] Each user opens **Settings → Mail**, checks the migrated IMAP account
      (the IMAP host is a guess from the SMTP host) and presses **Test &
      activate**, or connects Google / Microsoft instead. Until an account is
      active, that user cannot send from the app.
- [ ] For OAuth, the new env vars below must be set BEFORE users try to connect;
      the redirect URI registered with each provider must match
      `${APP_PUBLIC_URL}/api/mail/oauth/<google|microsoft>/callback` character
      for character. Full walkthrough: **`docs/mail-setup.md`**.

**New container environment** (none are required for the app to start; without
them mail simply stays IMAP-only and poll-only):

| Variable | Effect if unset |
| --- | --- |
| `APP_PUBLIC_URL` | OAuth Connect returns 503; Microsoft accounts poll instead of push. |
| `MAIL_SECRET_KEY` | `<data>/mail.key` is generated and used instead. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Connect Google unavailable. |
| `MS_OAUTH_CLIENT_ID` / `MS_OAUTH_CLIENT_SECRET` | Connect Microsoft unavailable. |
| `MS_OAUTH_TENANT` | Defaults to `common`. |

They are listed, commented out, in `docker-compose.yml` under the `app`
service's `environment:` block.

---

## Appendix — Quick command reference

> Replace `<prod-data>` with the Unraid host path mounted at `/app/data`
> (e.g. `/mnt/user/appdata/plan-takeoff/data`). All scripts default to
> `STORAGE_PATH`, falling back to `./data`, when `--data` is omitted.

| Action | Command |
| --- | --- |
| Full-data backup | `npm run backup -- --data <dir> [--dest <out>]` |
| Restore (rollback) | `npm run restore -- --from <backup-dir> --data <dir> --force` |
| Pre-migration manifest | `npm run migrate:manifest -- --data <dir> [--out <file>]` |
| Post-migration verify | `npm run migrate:verify -- --data <dir> [--manifest <file>] [--sample N]` |
| Run migrations (boot app) | `STORAGE_PATH=<dir> npx tsx server.ts` |
| Start prod (compose) | `docker compose up -d app` |
| Stop prod (compose) | `docker compose down` |
| Tail logs | `docker compose logs -f app` |

**Facts:**

- Latest schema version: **32** (migrations `1..32`, ending with the
  `mail_messages providerThreadId index`). Migration **11 (`tasks`)** and
  migration **31 (`mail-client`)** are the data-transforming ones.
- Compose **service**: `app` · **container**: `plan-takeoff-app` · **volume**:
  `./data:/app/data` · `STORAGE_PATH=/app/data`.
- Framework auto-backups land in **`<STORAGE_PATH>/backups/app-v<from>-<ts>.db`**
  (DB-only).
- Full-data backups (db **+** `files/`) are made with `npm run backup`; default
  dest is `<data>/../ft-backups/full-<timestamp>` when `--dest` is omitted.
- `npm run restore` refuses a non-empty target unless `--force` is given.
- `npm run migrate:verify` exits **non-zero** on any FAIL — gate the cutover on
  its exit code.
</content>
</invoke>
