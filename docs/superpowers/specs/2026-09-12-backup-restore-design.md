# Backup and Restore — Design

Date: 2026-09-12
Status: Approved by Nathan (conversation)

## Problem

The only backup today is a CLI directory copy (`scripts/backup-data.ts`, Phase 6
cutover tooling) that must be run by hand with the container stopped, copies
everything every time, and is not reachable from the app. Nathan wants:

1. A backup the app manages itself, that after the first full copy only
   transfers what changed.
2. The same thing pushed to Google Drive, since Google OAuth is already set up.
3. Complete disaster recovery: lose the server entirely, stand up a fresh one,
   and restore every project, document, file, user, and setting from the
   backup alone.

## Decisions (agreed with Nathan)

- **Server-managed snapshots in a content-addressed store** (approach A).
  A backup root holds every stored file exactly once, named by its SHA-256,
  plus per-snapshot folders with the database copy, the mail key, and a
  manifest. Incremental means "upload the hashes the store does not have".
- **A snapshot is self-contained and complete**: database + every referenced
  file + `mail.key`. Nothing else is needed to rebuild a server (the OAuth
  client id/secret live in the container environment, which is not data).
- **Restore is a first-run screen in the browser**, offered only while the
  install is fresh (default admin only, no projects, no files). Sources: the
  local backup root, an uploaded snapshot zip, or Google Drive. Restore ends
  with a process exit so the container restarts on the restored data.
- **Google Drive uses a dedicated admin grant** ("Connect Google Drive" in the
  Backup tab) with the `drive.file` scope only, reusing the environment's
  Google OAuth client. Mail accounts are untouched.
- **Schedule**: off or daily at a chosen time; local first, then Drive if
  connected. **Retention**: keep N snapshots per target (default 14), then
  prune objects no kept snapshot references.
- The Phase 6 CLI scripts stay as they are (they still serve the supervised
  cutover runbook).

## Storage layout

```
<BACKUP_PATH>/
  objects/<sha256>                       one file per distinct content, written once
  snapshots/<YYYYMMDD-HHMMSS>/
    app.db                               online-backup copy of the database
    mail.key                             AES key for sealed mail/Drive credentials
    manifest.json
```

`BACKUP_PATH` is an environment variable meant to point at a second mounted
share (docker-compose gains a commented example). If unset, the root is
`<DATA_DIR>/backup-store` and the Backup tab shows a persistent warning:
"Backups are on the same disk as the data. Set BACKUP_PATH to a different
volume." (`<DATA_DIR>/backups/` — the pre-migration database copies — is a
different folder and is left alone.)

`manifest.json`:

```json
{
  "format": 1,
  "createdAt": 1789000000000,
  "appVersion": "3.2.0",
  "schemaVersion": 36,
  "db": { "size": 733184, "sha256": "…" },
  "mailKey": { "sha256": "…" },
  "files": [ { "id": "<uuid>", "sha256": "…", "size": 12345 } ],
  "counts": { "files": 1234, "bytes": 987654321 },
  "warnings": [ "file <id> skipped: on-disk hash did not match the row after retry" ]
}
```

Excluded from snapshots: `<DATA_DIR>/tmp/**` (staged mail uploads),
`<DATA_DIR>/backups/**` (migration copies), `migration-manifest.json`, and the
legacy `*_migrated` folders (already imported by migrations 2/4/5).

A **snapshot zip** (for download and for upload-restore) is the snapshot
folder plus an `objects/` folder holding only the hashes that manifest
references. Zips are streamed, never buffered: the project has no zip
library today, so the plan adds `archiver` (streaming write) and `yauzl`
(streaming read), both stable, dependency-light packages. Uploads arrive as
a raw `application/octet-stream` body piped straight to a temp file (no
multipart parser is needed or present in the project).

## Server

### Module layout

| File | Responsibility |
|---|---|
| `server/backup/store.ts` | `LocalStore` — the object/snapshot layout on disk: `hasObject`, `putObject` (atomic tmp+rename), `readObject`, `listSnapshots`, `writeSnapshot`, `readManifest`, `prune`. Pure filesystem, no DB. |
| `server/backup/snapshot.ts` | `takeSnapshot(db, dataDir, target: BackupTarget, opts)` — the algorithm below; `BackupTarget` is the interface `LocalStore` and `DriveStore` both implement. |
| `server/backup/restore.ts` | `restoreSnapshot(dataDir, source: BackupSource, snapshotId)` — validation, object copy, verification, db/key placement. |
| `server/backup/zip.ts` | stream a snapshot to a zip; read a snapshot from an uploaded zip into a temp `LocalStore`. |
| `server/backup/drive.ts` | `DriveStore` (implements `BackupTarget` and `BackupSource`) over Drive API v3 with raw `fetch` + the mail subsystem's `TokenSource`; `driveOAuth` start/callback helpers. |
| `server/backup/scheduler.ts` | daily timer with injectable clock; runs local then Drive; records `backup_runs`. |
| `server/backup/routes.ts` | `registerBackupRoutes(app, deps)` — admin routes + setup-mode restore routes. |
| `server/backup/settings.ts` | typed read/write of `backup.*` settings keys (sealed Drive token). |

### Migration 36 (additive)

```
CREATE TABLE IF NOT EXISTS backup_runs (
  id            TEXT PRIMARY KEY,
  target        TEXT NOT NULL,        -- 'local' | 'drive'
  trigger       TEXT NOT NULL,        -- 'manual' | 'schedule'
  startedAt     INTEGER NOT NULL,
  finishedAt    INTEGER,
  status        TEXT NOT NULL,        -- 'running' | 'ok' | 'error'
  snapshotId    TEXT,
  objectsAdded  INTEGER NOT NULL DEFAULT 0,
  bytesWritten  INTEGER NOT NULL DEFAULT 0,
  warningsJson  TEXT NOT NULL DEFAULT '[]',
  error         TEXT
);
```

Settings keys (all private — excluded from the general settings GET/PUT like
`jwt.secret`): `backup.schedule` (`{ enabled, hour, minute }`),
`backup.keepLocal`, `backup.keepDrive`, `backup.drive` (sealed JSON
`{ refreshToken, email, folderId }`).

### Taking a snapshot (`takeSnapshot`)

1. Insert a `backup_runs` row (`running`). Only one run at a time per target;
   a second request while one is running gets 409 `{ code: 'backup_running' }`.
2. Copy the database with better-sqlite3's online backup API
   (`db.backup(tmpPath)`) — consistent while the app runs, WAL off or not.
3. Read every live and archived `files` row (`id, sha256, size`). For each
   hash the target does not already have: read `<DATA_DIR>/files/<id[0:2]>/<id>`,
   hash it while streaming, and if it matches the row, `putObject`. On a
   mismatch (a regenerate is mid-write) re-read once; if it still mismatches,
   record a warning and skip that file — the run still succeeds, and the
   manifest omits the entry so a restore never writes a corrupt blob.
   `DriveStore.hasObject` is answered from one paginated listing of
   `objects/` taken at the start of the run, not a request per file.
4. Write the snapshot: `app.db`, `mail.key` (from `<DATA_DIR>/mail.key`, or
   from `MAIL_SECRET_KEY` when the key comes from the environment — then the
   manifest says `mailKey.source: 'env'` and no file is written), and
   `manifest.json` **last**, so a snapshot folder without a manifest is by
   definition incomplete and is ignored by listings.
5. Prune: delete snapshots beyond `keep`, oldest first, then delete objects
   referenced by no remaining manifest. Never prune while another run is in
   progress.
6. Finish the run row (`ok` with counts, or `error` with the message).

A scheduled run does local then Drive. Failure of one target does not stop
the other. All errors are logged with the `[backup]` prefix.

### Setup mode and restore

- `GET /api/setup/state` (unauthenticated) → `{ fresh: boolean }`. Fresh =
  exactly one user, whose id is the default `admin-id-123`, and zero rows in
  `projects` and `files`. The route is cheap (three counts) and the client
  calls it on the login page only.
- All restore routes require `fresh === true` and otherwise return 409
  `{ code: 'not_fresh' }`. They also require the default admin's login
  (the `admin`/`admin` credentials the fresh install created), so a stranger
  on the LAN cannot restore over an empty server without at least that.
- `GET /api/setup/restore/sources` → local snapshots (`{ id, createdAt,
  appVersion, schemaVersion, counts }[]`), whether Drive is connectable
  (env has the Google client), and the local root path.
- `POST /api/setup/restore/upload` (multipart, streamed to a temp dir) →
  unpacks a snapshot zip into a temp `LocalStore` and returns its manifest
  summary + an `uploadId`.
- `POST /api/setup/restore/drive/connect` + callback → setup-mode Drive
  grant held **in memory only** (never written to the fresh database);
  `GET /api/setup/restore/drive/snapshots` lists the Drive snapshots.
- `POST /api/setup/restore` `{ source: 'local' | 'upload' | 'drive', snapshotId, uploadId? }`:
  1. Read the manifest; refuse if `format` is unknown or `schemaVersion` is
     newer than the running server's latest migration (400 with a message
     naming both versions — restore onto a newer app is fine, older is not).
  2. Copy every referenced object into `<DATA_DIR>/files/<id[0:2]>/<id>`
     via tmp+rename, verifying the SHA-256 as it streams; any mismatch
     aborts before the database is touched, leaving the fresh install usable.
  3. Write `mail.key` (replacing the one the fresh install generated — the
     sealed credentials in the restored database need the original) and
     `app.db.restored`.
  4. Respond `{ restarting: true }`, then close the database, rename
     `app.db.restored` → `app.db`, and `process.exit(0)`. The container's
     `restart: unless-stopped` policy (docker-compose.yml) brings it back on
     the restored data; on that start `runMigrations` brings an older
     snapshot's schema up to date as usual. Running outside Docker, the
     restore screen tells the user to start the server again.
  The client polls `GET /api/setup/state` until the server answers again
  (it will now say `fresh: false`), then routes to login.

### Backup routes (all `authenticateToken, requireAdmin`)

| Route | Purpose |
|---|---|
| `GET /api/backup/status` | root path + same-disk warning, last run per target, next scheduled run, totals (snapshots, objects, bytes), Drive connection (`{ connected, email }`), schedule + keep settings |
| `POST /api/backup/run` `{ target }` | manual run; 202 with the run id; 409 `backup_running` |
| `GET /api/backup/runs` | last 50 `backup_runs` |
| `GET /api/backup/snapshots?target=` | snapshot list for a target |
| `GET /api/backup/snapshots/:id/download` | streams the snapshot zip (local target) |
| `PUT /api/backup/settings` | schedule + keep counts |
| `GET /api/backup/drive/start` → `…/callback` | dedicated OAuth (scope `drive.file`, `access_type=offline`, `prompt=consent`, PKCE) — same helpers as `server/mail/oauth.ts` with a distinct state `typ` so a mail state cannot be replayed here; stores the sealed token; creates the root folder `Frugal Takeoff Backups` if missing |
| `DELETE /api/backup/drive` | disconnect (token removed; Drive contents untouched) |

Change-feed: a finished run broadcasts `{ type: 'backupRun', action: 'updated' }`
so an open Backup tab refreshes its status without polling.

### Drive specifics (`server/backup/drive.ts`)

- Folder layout under the root: `objects/` and `snapshots/<id>/`.
- `hasObject`: one `files.list` over `objects/` (`q: '<objectsFolderId>' in parents and trashed = false`,
  `fields: files(name)`, `pageSize: 1000`, paginated) → a `Set<string>` for the run.
- `putObject`: resumable upload (`uploadType=resumable`), 8 MB chunks,
  `name = <sha256>`, `parents = [objectsFolderId]`; retried once on a
  5xx/429 using the same retry-after handling as the Gmail provider.
- `writeSnapshot`: create `snapshots/<id>/`, upload `app.db`, `mail.key`,
  then `manifest.json` last.
- `listSnapshots`: folders under `snapshots/` that contain a `manifest.json`.
- `prune`: delete snapshot folders beyond `keep`, then objects not
  referenced by any remaining manifest (manifests are small; read them all).
- Restore source: `readManifest` + `readObject` (`alt=media` download) and
  `app.db`/`mail.key` downloads.
- Token: the sealed refresh token feeds the mail subsystem's `TokenSource`;
  `invalid_grant` marks the connection `needsReconnect`, surfaced in status.

### Scheduler

`startBackupScheduler({ db, now, setTimeout })`: computes the next
`hour:minute` occurrence, sleeps until then (timer `unref()`ed), runs local
then Drive with `trigger='schedule'`, reschedules. Reads the schedule
setting on each tick so a settings change takes effect without a restart.
A run that is still in progress at the next tick is skipped with a warning.

## Client

### Backup tab (`src/pages/settings/BackupTab.tsx`, admin-only, next to Storage)

- **Status card**: backup root + same-disk warning; last local / last Drive
  run (time, result, objects added, bytes; error text when failed); totals;
  next scheduled run; Drive: "Connected as <email>" with Disconnect, or
  "Connect Google Drive", or "Reconnect" when `needsReconnect`.
- **Actions**: "Back up now" and "Back up to Drive now" (disabled while a run
  is in progress; progress shown from the running row).
- **Schedule card**: enable toggle, time picker, keep-local and keep-Drive
  inputs, Save.
- **Snapshots table** (target switch local/Drive): date, app version, files,
  size, warnings count; "Download zip" on local rows.
- **Run history** (collapsed by default): last 50 runs.
- **Restore** is deliberately absent here (it only exists on a fresh install)
  and the card says so in one line.

### Fresh-install restore (`src/pages/RestorePage.tsx`, route `/restore`)

- The login page calls `GET /api/setup/state`; when fresh it shows a
  "Restore from backup" link under the form. `/restore` first asks for the
  default admin login (same form), then shows three sources side by side:
  local snapshots (from `BACKUP_PATH`), upload a snapshot zip (drag and
  drop, progress bar), Connect Google Drive → snapshot list.
- Picking a snapshot shows its summary (date, version, file count, size,
  warnings) and a Restore button with a confirm ("This replaces the empty
  database on this server. The server restarts when done.").
- After Restore: a full-screen "Restoring… / Restarting…" state that polls the
  setup state every 2 s for up to 5 minutes, then routes to `/login` with a
  toast "Restored. Sign in with your usual account."; if the server never
  comes back, it says so and tells the user to restart the container.

### Store helpers (`src/utils/store.ts`)

`getSetupState`, `getBackupStatus`, `runBackup(target)`, `getBackupRuns`,
`getBackupSnapshots(target)`, `backupSnapshotDownloadUrl(id)`,
`saveBackupSettings`, `disconnectDrive`, `getRestoreSources`,
`uploadRestoreZip(file, onProgress)`, `getDriveRestoreSnapshots`,
`restoreSnapshot(payload)`.

## Security notes

- Restore routes exist only while fresh and only for the default admin; the
  moment any project or file exists they 409.
- The Drive grant is `drive.file` (the app sees only files it created).
- Snapshot zips contain the mail key and every document; the download route
  is admin-only and the zip is never written to a web-reachable path.
- Sealed `backup.drive` is excluded from the general settings payloads
  exactly like `jwt.secret`.

## Out of scope

- Restoring into a populated server (undo-to-a-snapshot). The decision was a
  fresh-install screen only; a future "Restore" on a populated server would
  need a stop-the-world swap and is not designed here.
- Encryption of the backup store itself (the share's own protection applies).
- Backing up AI model weights (`/models`, separate volume, re-downloadable).
- Other cloud targets.

## Testing

Server (vitest, temp directories):
- `LocalStore`: put/has/read objects (atomic write, no partial files on
  error), snapshot listing ignores folders without a manifest, prune keeps
  exactly the objects referenced by kept manifests.
- `takeSnapshot`: first run writes every object and a manifest matching the
  files table; second run with no changes writes zero objects; a regenerate
  that rewrites a file in place yields one new object and a manifest pointing
  at the new hash; a hash mismatch produces a warning and omits the entry;
  concurrent run → 409; `backup_runs` rows recorded; `mail.key` included, or
  `source: 'env'` when the key is environmental.
- `restoreSnapshot`: a data dir rebuilt from a snapshot matches the original
  tree hash-for-hash; a snapshot with a newer `schemaVersion` is refused
  before any write; a corrupt object aborts before the database is touched.
- `zip`: round-trip a snapshot through the zip writer/reader.
- `DriveStore` against an injected `fetch`: paginated listing → `hasObject`,
  resumable upload with one retry on 503, snapshot manifest uploaded last,
  prune deletes the right ids, `invalid_grant` → `needsReconnect`.
- Scheduler with an injected clock: fires at the configured time, skips
  while a run is in progress, picks up a changed schedule on the next tick.
- Routes: setup state fresh/not-fresh; restore routes 409 when not fresh and
  401 without the default admin; backup routes admin-only; download streams a
  zip whose manifest matches.
- Migration 36 additive + replay no-op.

Client (vitest): BackupTab renders status/warning/Drive states and disables
actions while running; RestorePage source tabs, confirm, polling state
machine (server gone → back → routed to login).

Playwright (`e2e/backup-restore.spec.ts`): seed a project with a page and a
document; take a local snapshot from the Backup tab; download the zip; assert
the manifest inside lists the seeded file. Restore path: the e2e web server is
one `tsx server.ts` process with no restart (`playwright.config.ts`), so the
e2e cannot cross the process exit. A second test therefore runs **before**
seeding (the server is fresh): open `/restore`, sign in as the default admin,
upload a fixture snapshot zip (committed under `e2e/fixtures/assets/`, built
once from a seeded run by a script the plan adds), and assert the summary
(date, file count, size) — it stops at the confirm. The restore mechanics and
the exit are proven at unit level: `restoreSnapshot` takes an injectable
`exit` function, and the route test asserts it is called only after every
object is verified and the database file is in place.
