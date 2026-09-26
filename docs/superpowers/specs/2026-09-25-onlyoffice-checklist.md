# ONLYOFFICE Document Editing — Progress Checklist

**Branch:** `onlyoffice` (cut from `testing` at `09fe9a1`). All work for this
project is committed and pushed to `onlyoffice`. It merges into `testing` once,
when everything below is done and tested (see Phase 8).

**Goal:** replace the in-app PDF editor (`src/pages/PdfEditor.tsx`) and
spreadsheet editor (`src/pages/SpreadsheetEditor.tsx` + the Fortune Sheet
live-sync stack) with ONLYOFFICE Docs Community Edition, running as a second
container next to the app, and build the extras agreed below on top of it.

## How to use this file (for AI agents)

- This file is the **single source of truth** for progress on the ONLYOFFICE
  project. Read it at the start of any session on the `onlyoffice` branch.
- The **Decisions** section records what Nathan chose during planning. Don't
  reopen a decision without asking him; if something turns out to be
  impossible, stop and ask.
- Work phase by phase, top to bottom. Items within a phase can be reordered.
- Mark an item `[x]` **only with evidence** (tests passing; for UI, a Playwright
  or manual check), and append the commit hash: `[x] … (`abc1234`)`.
- Update this file **in the same commit** as the work it describes.
- Statuses: `[ ]` not started · `[~]` in progress (note what remains) ·
  `[x]` done with hash · `[-]` dropped (say why).
- Items marked **(Nathan)** are things only Nathan can do (server, DNS,
  testing). Don't mark them done yourself; ask him.

---

## Decisions (planning Q&A with Nathan, 2026-09-25)

| Topic | Decision |
|---|---|
| Edition | ONLYOFFICE Docs **Community Edition** (free, AGPL v3). **Phones are view-only**, which is accepted. |
| Hosting | Same Unraid server as the app, as another container. |
| Public access | Cloudflare → Nginx Proxy Manager → containers. ONLYOFFICE gets **its own subdomain** (e.g. `docs.<domain>`). |
| Old editors | **Replaced outright** on this branch. No fallback switch. |
| Save → versions | **One version per editing session.** The first save in a session keeps the old copy as a version; later saves in that session overwrite in place. |
| Generated documents (invoices, pay apps, proposals, RFIs, daily reports, change orders) | Editable. An edit becomes a **new version**, and the generated file stays in history. **Regenerating always makes a new version.** The "new version or replace?" prompt goes away. |
| Deleting versions | New option to delete **older** versions. Allowed for **admins, plus whoever made that version**. |
| Who can edit | Everyone, like today. Admin-only document kinds stay hidden from non-admins as now. |
| Files from your computer | "Open from computer" **uploads into a project** (pick project and document type), then opens. |
| Names shown in the editor | **Usernames** (no full-name field). |
| Notifications | New **notification bell in the sidebar, next to the user list** (`SidebarPresence`). Types: **@mentions**, **replies to my comments**, **tasks assigned to me**, **RFIs** (see next row). Bell only, no email. |
| RFI notifications | **Both**: add an internal **"Assigned to"** on RFIs (notified when assigned and when the GC answers), and record **who sent** the RFI (also notified when the GC answers). |
| Signatures | **Both** ONLYOFFICE's own signature feature and **profile signatures**. Users upload **several** signatures, **name each** one and pick a **default**. White background is removed on upload. |
| Company stamps | Admin-uploaded stamps (APPROVED, REVIEWED, company seal…) **shared by everyone**. |
| New blank files | **Word (.docx), Excel (.xlsx), PDF form.** No PowerPoint. |
| "New document" button | **Project → Documents tab**, **main Documents page**, **command palette**. Not inside the editor. |
| Templates | A **new admin-only "Document Templates" tab in Settings**. The **AIA Template tab stays where it is.** |
| Old or unusual formats (.xls, .doc, .rtf, .odt, Pages, Numbers…) | **Convert on upload** to .docx/.xlsx, **keeping the original as the previous version**. |
| AIA pay app PDF | A **"Make PDF" button** (not automatic). |
| Editor add-ons | **Version history + restore**, **insert images/signatures/stamps from the app**, **save copy to project**. |
| Extras | **Word/Excel mail attachments open in the viewer**, **thumbnails in Documents**, **share links open in the viewer**. |
| Sharing | **Any document** can be shared. New links **expire (default 30 days**; choose 7/30/90/never). You can **see and turn off** a file's active links. **Existing links keep working with no expiry** and appear in that list. |
| Testing | Nathan's **existing test container** moves to this branch. The ONLYOFFICE test subdomain is **`docs-test.<domain>`**. |
| Merge | **One merge into `testing` when everything is done and tested.** |

## Open questions (settle before the phase that needs them)

- [x] **Existing share links** (Phase 7): **keep them working with no expiry.**
  They show up in the new active-links list, where they can be turned off.
  (Nathan, 2026-09-25)
- [ ] **Replies to my comments** (Phase 5): ONLYOFFICE tells the app about
  @mentions (`onRequestSendNotify`) but has no event for replies. Plugin
  comment events (`onAddComment` / `onChangeCommentData`) are documented only
  for the Word editor, and only for comments added through the API. Do a short
  test first. If replies can't be caught everywhere, fall back to: "Word files
  only", or "replies that @mention you". Ask Nathan which.
- [x] **Test subdomain name** for ONLYOFFICE on the test setup (Phase 0):
  **`docs-test.<domain>`**. (Nathan, 2026-09-25)
- [ ] **ONLYOFFICE version to pin** (Phase 0): latest 9.4.x at the time. Never
  `latest`.

## Key technical facts (verified 2026-09-25)

- **How it works:**
  1. The app signs an editor config (JWT, shared secret).
  2. The browser loads `<ONLYOFFICE>/web-apps/apps/api/documents/api.js` and
     runs `new DocsAPI.DocEditor(el, config)`, which creates an iframe.
  3. The Document Server downloads the file from `document.url`.
  4. On save it POSTs to `editorConfig.callbackUrl`:
     - `status` 2 = closed with changes (about 10s after the last user leaves)
     - `status` 6 = forcesave (Save clicked with `customization.forcesave: true`)
     - `status` 4 = closed, no changes
     - `status` 3 / 7 = errors
  5. The handler downloads `body.url`, stores it, and must reply `{"error":0}`.
- **`document.key`** must change whenever the file's bytes change. Up to 128
  chars of `0-9a-zA-Z-._=`. Use `${fileId}-v${versionNumber}`: the live file id
  never changes (`server/files.ts:327` `saveNewVersion`), but the version
  number does.
- **Docker env:**
  - `JWT_ENABLED` defaults to true.
  - Set `JWT_SECRET` to the same value as the app's `ONLYOFFICE_JWT_SECRET`.
  - Set `ALLOW_PRIVATE_IP_ADDRESS=true`, or the Document Server refuses to
    fetch from the app over the Docker network.
- **9.4 (May 2026):**
  - The 20-open-documents limit is gone.
  - It runs as a single process with no RabbitMQ and no database.
  - Recommended: 4 GB RAM and 2 cores.
  - The image is about 1.3 GB.
  - The Document Server keeps no permanent data (only its cache), so nothing
    new needs backing up.
- **Paid-only features. Don't build on them:**
  - Automation API (`createConnector`)
  - `setReferenceData` (linked workbooks)
  - `customization.logo` / `customer` / `features`
  - Mobile editing
  - `onRequestCompareFile` (old compare API; the new `onRequestSelectDocument`
    is free)
- **Security rules:**
  - Never hand the user's 24h app JWT to the Document Server. Today
    `/api/files/:id/content` accepts `?token=` (`server/routes.ts:1205`).
    ONLYOFFICE gets its own **short-lived, single-file** download tokens.
  - The callback route sits outside `authenticateToken` (`server.ts:226`) and
    is verified with the ONLYOFFICE JWT.
  - Register all new `/api/*` routes **before** the JSON 404 catch-all
    (`server.ts:820`).
- **Where it plugs in:**
  - **Open in editor:** every open goes through `openTargetFor`
    (`src/pages/documents/openTarget.ts:23`).
  - **Editor routes:** `src/App.tsx:155-170`.
  - **File routes:**
    - `POST /api/files/:id` (`server/routes.ts:1159`)
    - `GET …/content` (`:1205`)
    - `POST …/versions` (`:1248`)
  - **Versions:** `saveNewVersion` / `listVersions` (`server/files.ts:327`, `:375`).
  - **Live refresh:** `broadcastChange({type:'file'…})`.
  - **Presence:** only `/tools/sheets` reports a `fileId` today
    (`src/utils/locationInfo.ts:24`).
  - **Signatures:** `removeWhiteBackground` is at `src/pages/PdfEditor.tsx:88`.
    Browser-saved signatures are in localStorage key `pdfEditorSignatures`
    (`:137`).
- **Keep** `src/utils/pdfOverlayTransform.ts`. The takeoff printout pipeline
  uses it (`proposalGenerator.ts`). The takeoff canvas shares no code with the
  PDF editor.
- **Images:** `.github/workflows/docker.yml` builds images only for listed
  branches. Its default tagging publishes
  `ghcr.io/phlurblepoot/frugal-takeoff:<branch>`.

---

## Phase 0 — Infrastructure and test setup

- [x] Add `onlyoffice` to the push branches in `.github/workflows/docker.yml`
  so every push builds `ghcr.io/phlurblepoot/frugal-takeoff:onlyoffice`.
  (`b66a8d1`; first image built green in Actions run #543)
- [x] `docker-compose.yml`: an `onlyoffice` service pinned to
  `onlyoffice/documentserver:9.4.0.1`, with `JWT_SECRET`,
  `ALLOW_PRIVATE_IP_ADDRESS=true` and `restart: unless-stopped`. Both services
  share compose's default network. (`b66a8d1`)
- [x] App env vars, documented in `.env.example` and `docker-compose.yml`
  (`b66a8d1`):
  - `ONLYOFFICE_PUBLIC_URL`: what browsers use, e.g. `https://docs.<domain>`
  - `ONLYOFFICE_INTERNAL_URL`: what the app uses for commands and
    conversions. Defaults to the public URL.
  - `APP_INTERNAL_URL`: what the Document Server uses to reach the app.
    Defaults to `APP_PUBLIC_URL`.
  - `ONLYOFFICE_JWT_SECRET`
- [x] `docs/onlyoffice-setup.md`: Unraid containers and a shared custom
  network, the Nginx Proxy Manager proxy host (WebSockets on, SSL), the
  Cloudflare record, a `/healthcheck` quick check, and a troubleshooting table
  keyed to the Settings messages. (`b66a8d1`)
- [x] Admin **Settings → Document Editor** tab (`b66a8d1`):
  - Server: `server/onlyoffice/` has `config.ts` (reads and validates env),
    `tokens.ts` (short-lived single-purpose link tokens, key derived from the
    app secret so they can never pass as logins) and `client.ts` (signed
    `/command` and `/converter` calls, reused in Phase 1/4).
  - Routes: `GET /api/onlyoffice/status` (admin) and the token-gated
    `GET /api/onlyoffice/selftest/:id`.
  - The checks:
    - app → ONLYOFFICE via the command service's `version` call (also proves
      the secret matches)
    - ONLYOFFICE → app via a `txt → docx` conversion that downloads a test file
      from `APP_INTERNAL_URL`
    - browser → ONLYOFFICE by loading `api.js` (`src/utils/onlyofficeApi.ts`,
      reused in Phase 1)
  - Each failure names the setting to fix.
  - Evidence:
    - unit tests `server/onlyoffice/*.test.ts` (18, including a fake Document
      Server that verifies both signatures and really downloads the test file),
      `src/utils/onlyofficeApi.test.ts` and
      `src/pages/settings/DocumentEditorTab.test.tsx`
    - e2e `e2e/onlyoffice-settings.spec.ts`
    - a manual browser run against a stand-in Document Server showing both the
      failure messages (ECONNREFUSED) and three **Working** checks
    - full unit suite 3227/3227 (270 files)
    - full e2e suite: 102 passed, 1 skipped (the conditional fresh-install
      restore spec, skipped before this work too)
- [x] **(Nathan)** Check the Unraid server has about 4 GB of RAM to spare. (2026-09-25)
- [x] **(Nathan)** Create the test subdomain `docs-test.<domain>` in Cloudflare
  and Nginx Proxy Manager (guide §5). (2026-09-25)
- [x] **(Nathan)** Start the ONLYOFFICE test container. Point the existing test
  app container at the `:onlyoffice` image with the four variables (guide §4).
  (2026-09-25)
- [x] **(Nathan)** Settings → Document Editor on the test app shows three
  **Working** checks against the real ONLYOFFICE. (2026-09-25)

## Phase 1 — Core editor (replaces the old editors)

**Server** (`server/onlyoffice/`), all in `5b40b46`:
- [x] Config builder (`editorConfig.ts`):
  - file type → `documentType` (pdf / word / cell / slide), from the shared
    table `src/utils/officeFormats.ts`
  - `key` = `${fileId}-v${versionNumber}-${sha256[0..12]}`. The hash covers an
    "overwrite" regenerate, which resets the version number to 1.
  - user = `{ id, name: username }`
  - `permissions`: edit, comment, review (track changes) and fill forms when
    editing
  - `customization.forcesave: true` and a Close button
  - `uiTheme` follows the app's light/dark theme at open
  - signed with the shared JWT secret
  - titles always carry the extension (generated documents often don't)
- [x] `POST /api/onlyoffice/config/:fileId` (signed-in users):
  - returns the signed config
  - phones get `type: "mobile"`, `mode: "view"`; legacy formats and old
    versions also open view-only
  - admin-only kinds are hidden from non-admins, as in Documents
  - error codes: `not-configured` / `unsupported` / `onlyoffice-unreachable`
- [x] `GET /api/onlyoffice/file/:fileId?t=`: ONLYOFFICE-only download with an
  8-hour single-file link token.
- [x] `POST /api/onlyoffice/callback/:fileId`:
  - verifies ONLYOFFICE's signature (Bearer header by default, or `token` in
    the body) and trusts only the signed fields
  - checks the key belongs to this file
  - saves on 2/3/6/7, as ONLYOFFICE's reference handler does; 3/7 are logged
  - ends the session on 2/3/4
  - saves for a file are applied one at a time
  - downloads over `ONLYOFFICE_INTERNAL_URL` first
  - replies `{"error":1}` on failure, so ONLYOFFICE keeps the edits and tells
    the editors
  - has its own 10 MB body parser
- [x] Version rule, via `editor_sessions` (migration 37):
  - the first save archives the pre-session bytes
  - later saves overwrite in place only while the live file is still exactly
    what this session wrote (version and hash); otherwise a new version
  - identical bytes add no version
  - everyone who opens the file during a session gets that session's key
  - a session ONLYOFFICE no longer has (checked with the command service's
    `info`) is dropped
- [x] Migration 37: `files.createdBy`, set on upload, new-version upload,
  regenerate and editor saves. Archived versions keep their author.
  `replaceLiveContent` updates size and hash on in-place saves.
- [x] `broadcastChange` on every save, so Documents refreshes live.

**Client** (`330802e`):
- [x] `src/pages/DocumentEditor.tsx` at `/tools/edit?fileId=`:
  - loads `api.js` from the public URL the server returns
  - mounts the editor into a plain placeholder node
  - calls `destroyEditor` on unmount
  - Close goes back
  - errors (not set up, unreachable, `api.js` won't load, unsupported, not
    found) get a clear message, a Settings link for admins ("ask an admin" for
    others) and **Download instead**
  - the sidebar collapses to the rail while a file is open, like the canvas
  - renders nothing in PageTransition's outgoing copy (`useIsPresent`): that
    wrapper briefly renders a newly entered route a second time, which started
    ONLYOFFICE twice on every in-app "Open" and dropped a dialog opened in that
    first moment. The e2e test asserts one config request. (`051352f`)
- [x] `/tools/pdf`, `/tools/sheets`, `/pdf-editor` and `/spreadsheet-editor`
  redirect to `/tools/edit`, keeping `fileId`.
- [x] `openTargetFor` sends every office format to `/tools/edit`:
  - known extension first, then mime
  - `kindFromMime` maps Word, PowerPoint and OpenDocument files to `document`
  - `MimeIcon` has Word, Excel and PowerPoint glyphs
- [x] File pickers get an `office` accept category (`FilePickerModal`,
  `AddFilesButton`, `useDropZone`). The preview modal's "Open in editor" now
  opens Word/PowerPoint too; the preview itself stays a generic card for them.
- [x] Sidebar and command palette: one **Document Editor** entry replaces "PDF
  Editor" and "Spreadsheet". The landing page lists recently opened files
  (client-side, like recent projects), plus **Open from Documents** and **Open
  from computer**.
- [x] "Open from computer" (`OpenFromComputerModal`):
  - pick an active project (required) and a type (Document / Spreadsheet /
    Other / custom types)
  - uploads with the project's customer, then opens the file
  - turns away non-editor files before uploading
- [x] Presence: `locationInfo` reports `fileId` for `/tools/edit`, so the
  Documents "being edited" dots work for every file type; the presence label is
  "Document editor".

**Remove the old editors** (`330802e`):
- [x] Moved `removeWhiteBackground` into `src/utils/removeWhiteBackground.ts`,
  with its pixel rule split out and unit-tested.
- [x] Deleted `PdfEditor.tsx` and `SpreadsheetEditor.tsx` (and their tests).
- [x] Deleted `src/utils/sheetBridge.ts` (and its tests).
- [x] Deleted `server/realtime/sheetFlush.ts` and `sheetSessions.ts` (and their
  tests, and `registerRealtime.sheets.test.ts`).
- [x] Removed the `sheet-*` socket events, sheet rooms and last-leave flush from
  `registerRealtime.ts`, and their client helpers and tests in
  `CollaborationContext.tsx`.
- [x] `server.ts`:
  - no sheet store or flush engine
  - shutdown now only stops mail sync
  - the socket buffer is back to socket.io's default (the 30 MB limit existed
    only for sheet state)
- [x] Removed the `sheetStore.clearSession` hooks in `server/routes.ts`.
- [x] Removed the drafts API (routes and client helpers), plus the now-unused
  client `saveFileVersion`. The `POST /api/files/:id/versions` route stays.
- [x] Deleted `e2e/sheets-editor.spec.ts`, `e2e/collab-sheets.spec.ts` and the
  `seedSpreadsheetFile` fixture. Dropped `SHEET_FLUSH_INTERVAL_MS` from the
  Playwright server command.
- [x] Uninstalled `@fortune-sheet/react`. `xlsx` and `exceljs` stay: the AIA
  export, SOV import, takeoff export and preview use them.
- [x] Left the old `sheet_sessions`, `sheet_ops` and `drafts` tables in place,
  unused. The project-delete cascade and the regenerate path still clear old
  `drafts` rows. Dropping them is in "Later".

**Tests:**
- [x] Unit tests:
  - `server/onlyoffice/editorRoutes.test.ts` (21, against a fake Document
    Server that signs callbacks and serves saves): config contents and
    signature; file-link scope; view-only cases; admin-only and unsupported
    files; session joining; dead-session recovery; unreachable ONLYOFFICE;
    unsigned, wrong-secret and wrong-file callbacks; the one-version-per-session
    rule; an outside change mid-session → new version; unchanged bytes;
    status 4; body-token form; internal-then-given download; failed download →
    `{"error":1}`; status 3; deleted file; format change; back-to-back saves
  - plus `files.test.ts` (createdBy, `replaceLiveContent`), migration 37,
    `officeFormats`, `openTarget`, `DocumentEditor.test.tsx` (fake DocsAPI:
    config passthrough, teardown, phone, Close, every error state, landing),
    `OpenFromComputerModal.test.tsx`, `removeWhiteBackground`
  - full unit suite 3174/3174 (268 files)
- [x] E2E, `e2e/document-editor.spec.ts`, against the unconfigured e2e server
  (instead of a stubbed `api.js`):
  - the not-set-up error with its Settings link and a working download
  - old-link redirects
  - sidebar → landing
  - "Open from computer" filing the upload into a project
  - `e2e/documents.spec.ts` now expects `/tools/edit`
  - full e2e suite at `051352f`: 102 passed, 1 skipped (a conditional spec,
    skipped before this work too)
  - an earlier full run that overlapped a smoke test found the Settings-spec
    name clash and the transition double-mount, both fixed in `051352f`
- [x] Manual run against a stand-in Document Server over real HTTP:
  - opened from Documents → `/tools/edit` with a word/edit config
  - the stand-in downloaded the file through its link
  - Save → version 2; second Save → same version 2 overwritten; close →
    overwritten and session ended; the next open got a new key
  - the page fills the screen beside the rail
- [x] **(Nathan)** Manual check on the test container with the real ONLYOFFICE:
  - edit and save a PDF, an .xlsx and a .docx
  - two users editing the same file
  - phone view-only
  - Documents shows the new version after closing

  (Nathan, 2026-09-26: "tested it all, everything works")

## Phase 2 — Versions and generated documents

- [x] Regenerate always creates a new version. Remove the
  `VersionOrOverwriteDialog` prompt from the `DocumentActionsBar` regenerate
  paths, and stop sending `mode=overwrite` for generated documents.
  - The dialog and its test are deleted. The server's overwrite mode
    (`overwriteLive`, `PutOpts.mode`) is gone too, so an old client asking
    for it still gets a new version.
  - The toast after a regenerate says the previous version is kept.
  - Archived versions now keep the date their bytes were made, not the date
    they were archived (the history showed every version at the time of the
    next one).
- [x] Update `useGeneratedDocument` / `DocumentStatusChip` so an ONLYOFFICE edit
  reads correctly ("edited after generating").
  - Editor saves stamp `files.versionOrigin = 'editor'`; a restore stamps
    `'restore'`; an upload or generate clears it. `/api/documents/by-source`
    returns it.
  - Chip: "PDF edited" (blue), or "PDF edited, out of date" once the record
    changes after the edit; "Earlier PDF restored" (amber). Tooltips explain.
  - An edited document counts as current until the record changes after the
    edit, so Send mails the edited copy (the edit is deliberate, e.g. a
    signature). A restored older version never counts as current, so Send
    rebuilds.
- [x] Delete older versions: `DELETE /api/files/:id/versions/:versionId`.
  - Allowed for admins, or the version's `createdBy`. Old versions with no
    `createdBy` are admin-only.
  - The live version can't be deleted this way.
  - Add a trash button in the Documents version history list, with a confirm.
  - The Documents version list (`src/pages/documents/VersionHistory.tsx`) also
    shows who made each version, an "edited"/"restored" tag, download (named
    `Scope (v2).docx`) and **restore** with a confirm.
- [x] In-editor version history:
  - `onRequestHistory` lists `/api/files/:id/versions`
  - `onRequestHistoryData` returns a signed per-version URL
  - `onRequestRestore` restores **as a new version**, so nothing is lost
  - Built as: `GET /api/onlyoffice/history/:fileId` (the list, with authors
    and change logs; the current version carries the open session's key) and
    `GET /api/onlyoffice/history/:fileId/:version` (signed `setHistoryData`,
    with `previous` and `changesUrl` when a log was kept). Leaving the history
    view restarts the editor, as ONLYOFFICE requires. Restore is only offered
    where the file opens for editing.
  - Restore is `POST /api/files/:id/restore` (Documents page and editor):
    - No editing session: the version's bytes become a new version on top.
    - Open in the editor: only the person restoring, from inside that editor,
      alone in it, may restore. Anyone else gets "X is editing this file";
      the Documents page tells you to use the editor's Version History.
    - Then ONLYOFFICE is asked to save what is open (command `forcesave`), and
      the restore waits for that save (30 s, else nothing changes). So typing
      that hadn't been saved yet is kept as its own version.
    - The session is then retired (`editor_superseded_sessions`); the next
      open starts fresh on the restored file. ONLYOFFICE's late closing save
      for the old session is dropped unless it holds changes made after the
      restore (by the change dates it sends; by the bytes when it sends none).
- [x] Store the callback's `history` / `changesurl` per version, so version
  history can highlight what changed. (server, 2026-09-26)
  - Kept in `editor_changes` (migration 38) when a session closes (status 2
    or 3), against the version that session made. Only when the session made
    exactly one version on top of what it opened; otherwise ONLYOFFICE would
    highlight against the wrong earlier version. The zip is downloaded and
    stored, since ONLYOFFICE's link expires.
  - The editor frame downloads the zip itself, cross-origin:
    `GET /api/onlyoffice/changes/:fileId/:version?t=` answers with
    `Access-Control-Allow-Origin` set to ONLYOFFICE's public address.
- [x] Tests: regenerate → new version; delete-version permissions; restore
  creates a version.
  - `server/onlyoffice/historyRoutes.test.ts` (21, fake Document Server that
    answers `info` and `forcesave` and posts the save back): the list, signed
    data, change-log CORS and link scope, admin-only files, restore by number
    and by row id, current/other-file refusals, extension follows the bytes,
    others editing → 409, Documents-page restore while open → 409, stale
    session ignored, save-first-then-restore, nothing unsaved, save timeout →
    nothing changes, late closing save dropped / kept by date / judged by
    bytes, `changeTimes`
  - `editorRoutes.test.ts` +6: users tracked, `versionOrigin`, change log
    stored (also when the close brings no new bytes), not stored when the
    session made two versions, a failed log download never fails the save
  - `files.test.ts`: regenerate always versions (even with `mode=overwrite`),
    archived dates, delete-version permissions (author, non-author, admin,
    no author, live row, other file)
  - client: `VersionHistory.test.tsx` (7), `DocumentEditor.test.tsx` +7
    (history, data, close → restart, restore, restore refused, view-only has
    no Restore), `DocumentActionsBar`, `useGeneratedDocument`, proposal and
    punch tests updated for the missing prompt
  - full unit suite 3215/3215 (269 files)
  - e2e: `document-actions.spec.ts` and `mail-item-send.spec.ts` regenerate
    without a prompt; `documents.spec.ts` new "version history: restore …
    delete" test
  - full e2e suite: 102 passed, 1 skipped (the same conditional spec), 1
    failed: `mail-item-send.spec.ts` still clicked the removed prompt. Fixed
    in the same commit as this line; that spec then passed (2/2)
  - smoke against the real server and a stand-in Document Server over HTTP
    (13 checks): session → one "edited" version with its log; history list and
    signed data; the log downloads cross-origin; restore blocked from the
    Documents page while open; in-editor restore kept the unsaved typing as
    v3 and restored v1 as v4; the old session's late close was dropped; the
    next open got a fresh key; blocked while someone else edits; delete v2;
    the live version can't be deleted
- [x] **(Nathan)** Manual check on the test container with the real ONLYOFFICE:
  (Nathan, 2026-09-26: "tested it all, everything works")
  - edit a document, close it, then File → Version History: the versions show
    with names, and the edited one highlights its changes
  - restore an older version from the editor, and from the Documents page
    (with the file closed)
  - regenerate an invoice PDF: no prompt, a new version appears; delete an old
    one from Documents
  - edit a generated PDF in the editor: its chip says "PDF edited"

## Phase 3 — New documents, templates, signatures and stamps

- [x] Bundle ONLYOFFICE's blank `new.docx`, `new.xlsx` and `new.pdf` (form)
  from `ONLYOFFICE/document-templates` (Apache-2.0; keep the license notice).
  - The en-US files (Letter paper), unchanged, in
    `server/documentLibrary/blank/` with `LICENSE` and a `NOTICE.md` naming
    the source commit.
- [x] `POST /api/documents/new`: blank or template, name, projectId, kind. It
  copies into storage with `createdBy` and returns the fileId.
  - `server/documentLibrary.ts` + `documentLibraryRoutes.ts`. The project is
    required except for company documents; the kind must be an upload kind
    (not photo); a template must match the type; the name gets its extension.
  - Templates, company stamps and signatures are ordinary files with three
    new system kinds (`document-template`, `company-stamp`, `signature`):
    hidden from Documents, kept by the Storage orphan cleanup, versions and
    backups work unchanged. Templates open in the editor for admins only.
- [x] "New document" dialog:
  - type: Word / Excel / PDF form
  - start from: Blank or a template of that type
  - name
  - project: preselected inside a project, required on the main page
  - document type
  - then opens the editor
  - (`src/pages/documents/NewDocumentModal.tsx`. A company document needs no
    project. Archived projects aren't offered.)
- [x] Buttons on **Project → Documents** and the **main Documents page**.
  Command-palette actions "New Word document", "New spreadsheet" and "New PDF
  form".
  - Project → Documents is the Documents page filtered to that project, so it
    is one "New document" button; filtered to one project, that project is
    preselected. The palette opens it with `?new=docx|xlsx|pdf`, keeping the
    project you are in (or the Documents filters you came from).
- [x] Settings → new admin-only **Document Templates** tab (the AIA Template tab
  stays):
  - add, rename and delete templates
  - templates open in the editor for changes
  - stored as a system file kind so they don't show up in project Documents
- [x] Offer `docs/Template.docx` (letterhead) as a one-click starter template.
  ("Add company letterhead", shown until a `Letterhead.docx` template exists.)
- [x] Profile signatures under Settings → User Preferences → "My signatures":
  - upload several
  - name each one
  - pick a default
  - white background removed on upload
  - Private to their owner: the list, changes and the bytes (also blocked on
    the login-free `/api/images/:id/raw` route). Removed with their user.
- [x] One-time import of any browser-saved `pdfEditorSignatures` from the old
  editor. (When My signatures first opens in that browser; a signature that
  fails to upload stays for the next try.)
- [x] Company stamps: managed in the Document Templates tab (admins upload, with
  the same background removal). Everyone can insert them.
- [ ] Editor **Insert → Image → From storage** (`onRequestInsertImage`) opens a
  picker with: My signatures (default first), Company stamps, Project photos,
  and other images in Documents. It inserts through signed URLs.
- [ ] **Save copy to project** (`onRequestSaveAs`): the copy (e.g. a PDF of a
  Word letter) is saved as a new file in the same project's Documents.
- [ ] Check ONLYOFFICE's own signature fields work (no code expected).
- [ ] Tests: new-document route, template kinds hidden from project lists,
  signature CRUD and permissions.

## Phase 4 — Conversions

- [ ] Conversion API client (`/converter`, JWT, async polling) in
  `server/onlyoffice/`.
- [ ] **Old formats on upload** (.xls, .doc, .rtf, .odt, .ods, .pages,
  .numbers…):
  - the original is saved first
  - the converted .docx/.xlsx is saved as a new version with the extension
    updated
  - if conversion fails, keep the original and show a warning
- [ ] **AIA pay app "Make PDF" button**:
  - converts xlsx → pdf with `region: en-US`
  - saved as a PDF linked to the pay app
  - offered as an attachment when emailing the pay app
- [ ] **Thumbnails in Documents**:
  - first-page PNG (`thumbnail.first`), cached per file version (sha256)
  - generated in the background after upload or save
  - shown in the Documents list and grid, with an icon fallback
- [ ] Tests: conversion client (mocked Document Server), upload conversion keeps
  the original, thumbnail cache.

## Phase 5 — Notification bell

- [ ] `notifications` table (id, userId, type, title, body, link, createdAt,
  readAt) plus routes: list, mark read, mark all read.
- [ ] Push new notifications live over the existing socket.
- [ ] Bell in the sidebar **next to the user list** (`SidebarPresence`):
  - unread badge
  - panel listing notifications
  - clicking one opens its link and marks it read
  - works collapsed and expanded, and on mobile
- [ ] **@mentions** in document comments:
  - `onRequestUsers` (`c: "mention"`) returns the app's users
  - ONLYOFFICE keys mentions by email and users have none, so use a stable
    per-user id address and map it back
  - `onRequestSendNotify` creates a notification with a link that opens the
    document at the comment (`onMakeActionLink` / `actionLink`)
- [ ] **Replies to my comments**: settle the open question above first, then
  build what's possible.
- [ ] **Tasks assigned to me**: notify on assign and reassign (`server/taskStore.ts`).
  No notification when you assign yourself.
- [ ] **RFIs**:
  - Add migration `rfis.assigneeUserId` and an "Assigned to" field on the RFI
    form.
  - Record `sentByUserId` when an RFI is sent.
  - Notify the assignee when assigned.
  - Notify the assignee and the sender when a GC answer is detected (mail
    inbound hook).
- [ ] Tests: notification store and routes, and each trigger.

## Phase 6 — Viewers: mail attachments and share links

- [ ] **Mail attachments:** Word, Excel and PowerPoint attachments (and old
  formats) open in the ONLYOFFICE viewer (`mode: view`) instead of downloading.
  - They're served to the Document Server with a short-lived per-attachment
    token.
  - "Save to project" (`SaveAttachmentsModal`) stays.
  - Change `src/pages/mail/AttachmentChips.tsx`, which currently opens only
    PDFs and images inline.
- [ ] **Share links:** `/share/:id` opens the ONLYOFFICE embedded viewer
  (`type: embedded`, view-only, anonymous) for any document type. This works on
  phones.
- [ ] Tests: attachment token scope; the share viewer config never grants edit.

## Phase 7 — Sharing upgrades

- [ ] Share button for **every document** (Documents row menu and preview
  modal), not just takeoff printouts.
- [ ] Migration: add `expiresAt` and `revokedAt` to `shares`.
  - Choose 7 / **30 (default)** / 90 days / never when creating a link.
  - Public share routes return a friendly "link expired" page.
- [ ] Existing links migrate with `expiresAt = NULL` (never expire), keep
  working, and appear in the active-links list, where they can be turned off.
- [ ] Creating a share no longer silently reuses an old link (`server.ts:547`)
  once expiry exists.
- [ ] Per-file **active links list** with "Stop sharing".
- [ ] Fix the README's sharing description to match.
- [ ] Tests: expiry, revoke, public routes reject expired or revoked links.

## Phase 8 — Finish and merge

- [ ] `npm run lint`, `npm test` and `npm run test:e2e` all passing.
- [ ] **(Nathan)** Full walkthrough on the test container:
  - edit PDF, xlsx and docx
  - two people editing at once
  - phone view
  - new document from blank and from a template
  - insert signature and stamp
  - version history, restore and delete
  - regenerate a generated document
  - AIA Make PDF
  - old-format upload
  - mail attachment viewer
  - share link with expiry and stop-sharing
  - bell notifications (mention, task, RFI)
- [ ] Docs:
  - README (feature overview, editor sections, tech stack, deployment)
  - `docs/onlyoffice-setup.md` final pass
  - `.env.example`
- [ ] Changelog entry in `src/pages/Settings.tsx`, and version bump to **4.0.0**
  (the editors are replaced and a new container is required).
- [ ] Production rollout notes:
  - back up
  - add the production ONLYOFFICE container and subdomain
  - set env vars
  - switch image
- [ ] Merge `onlyoffice` into `testing`. Remove the ONLYOFFICE note from
  `CLAUDE.md`.

---

## Later (not in this project)

- **Frugal Takeoff panel inside the editors** (plugin): insert takeoff
  quantities, price packages, and project or customer info.
- **Word templates for generated documents**: design proposals, invoices and
  change orders in Word; the app fills them in and converts to PDF. Replaces
  hand-coded jsPDF layouts.
- **AI plugin with a local model** (Ollama / LM Studio / OpenAI-compatible).
- **Compare / combine** with another file from Documents
  (`onRequestSelectDocument`).
- **Mail merge** from the customers list.
- **PDF forms "Complete & Submit"** turns field values into app records.
- **Locked cell ranges** with the app's user list (`onRequestUsers`
  `c: "protect"`). Nearly free once @mentions exist.
- **Rename inside the editor** kept in sync with Documents (`onRequestRename`).
- **"Save as PDF" for any spreadsheet**, not just AIA.
- More notification types (a file I edited was changed, etc.).
- Drop the unused `sheet_sessions`, `sheet_ops` and drafts tables.
