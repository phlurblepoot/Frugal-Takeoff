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
- [ ] **(Nathan)** Check the Unraid server has about 4 GB of RAM to spare.
- [ ] **(Nathan)** Create the test subdomain `docs-test.<domain>` in Cloudflare
  and Nginx Proxy Manager (guide §5).
- [ ] **(Nathan)** Start the ONLYOFFICE test container. Point the existing test
  app container at the `:onlyoffice` image with the four variables (guide §4).
- [ ] **(Nathan)** Settings → Document Editor on the test app shows three
  **Working** checks against the real ONLYOFFICE.

## Phase 1 — Core editor (replaces the old editors)

**Server** (`server/onlyoffice/`):
- [ ] Config builder:
  - file type → `documentType` (pdf / word / cell / slide)
  - `key` = `${fileId}-v${versionNumber}`
  - user = `{ id, name: username }`
  - `permissions`: edit, comment and review (track changes) for everyone
  - `customization.forcesave: true`
  - `uiTheme` follows the app's light/dark theme
  - sign with the JWT
- [ ] `POST /api/onlyoffice/config/:fileId` (signed-in users) returns the signed
  config. On phones it returns `type: "mobile"`, `mode: "view"`, so there's a
  clean viewer instead of an error.
- [ ] `GET /api/onlyoffice/file/:fileId?t=` serves the file to the Document
  Server only. The token is short-lived and valid for that one file.
- [ ] `POST /api/onlyoffice/callback/:fileId`:
  - verify the Document Server's JWT
  - on status 2/6, download `body.url` and save it using the version rule below
  - record `users[0]` as the version's author
  - on 3/7, log the error and flag it on the file
  - always reply `{"error":0}`
- [ ] Version rule: **one version per editing session**, tracked in a small
  `editor_sessions` table.
  - The first save archives the pre-session bytes.
  - Later saves in the same session overwrite in place, **but only if the live
    version is still the one this session wrote**.
  - If anything else made a version meanwhile (regenerate, upload, restore),
    the save becomes a new version, so nothing is ever overwritten.
- [ ] Migration: `files.createdBy` (userId). Set it on upload, generate and
  editor save.
- [ ] `broadcastChange` on every save, so Documents refreshes live.

**Client:**
- [ ] New page `src/pages/DocumentEditor.tsx` at `/tools/edit?fileId=`:
  - loads `api.js` from `ONLYOFFICE_PUBLIC_URL` (passed down from the server)
  - mounts the editor and calls `destroyEditor` on unmount
  - if the Document Server can't be reached, shows a friendly error with a
    Download button
- [ ] Redirect `/tools/pdf`, `/tools/sheets`, `/pdf-editor` and
  `/spreadsheet-editor` to `/tools/edit`, keeping `fileId`.
- [ ] `openTargetFor` sends PDF, Word, Excel and PowerPoint (plus old formats) to
  `/tools/edit`. Add the docx/pptx mimes, and map docx in `kindFromMime`.
- [ ] Update the preview modal, `FilePickerModal` type lists and
  `DocumentViewerModal` "Open in editor" for Word files.
- [ ] Sidebar and command palette: one "Documents editor" entry replaces
  "PDF editor" and "Spreadsheets". Opened with no file, it shows recent files
  plus "Open from Documents" and "Open from computer".
- [ ] "Open from computer": pick a project and document type, upload, then open
  in the editor.
- [ ] Presence: `locationInfo` reports `fileId` for `/tools/edit`, so the
  Documents "being edited" dots (`FileViewerDots`) work for every file type.

**Remove the old editors:**
- [ ] First move `removeWhiteBackground` into `src/utils/` (Phase 3 needs it).
- [ ] Delete `PdfEditor.tsx` and `SpreadsheetEditor.tsx` (and their tests).
- [ ] Delete `src/utils/sheetBridge.ts` (and its tests).
- [ ] Delete `server/realtime/sheetFlush.ts` and `sheetSessions.ts` (and their
  tests).
- [ ] Remove the `sheet-*` socket events from `registerRealtime.ts` and their
  client helpers in `CollaborationContext.tsx`.
- [ ] Remove the `sheetStore.clearSession` hooks in `server/routes.ts`.
- [ ] Remove the drafts API (`server/routes.ts:1624-1660`,
  `src/utils/store.ts:912-930`).
- [ ] Delete `e2e/sheets-editor.spec.ts` and `e2e/collab-sheets.spec.ts`.
- [ ] Uninstall the `@fortune-sheet/react` dependency.
- [ ] Leave the old `sheet_sessions`, `sheet_ops` and drafts tables in place
  unused. Drop them later (see "Later").

**Tests:**
- [ ] Unit tests:
  - config builder and JWT
  - download-token scope and expiry
  - the callback state machine: statuses 2/4/6/3; the one-version-per-session
    rule; "someone else made a version mid-session" → new version
- [ ] E2E with a stubbed `api.js` (a fake `DocsAPI` in test mode): open from
  Documents, redirects, open from computer, error state when the Document
  Server is down.
- [ ] **(Nathan)** Manual check on the test container:
  - edit and save a PDF, an .xlsx and a .docx
  - two users editing the same file
  - phone view-only

## Phase 2 — Versions and generated documents

- [ ] Regenerate always creates a new version. Remove the
  `VersionOrOverwriteDialog` prompt from the `DocumentActionsBar` regenerate
  paths, and stop sending `mode=overwrite` for generated documents.
- [ ] Update `useGeneratedDocument` / `DocumentStatusChip` so an ONLYOFFICE edit
  reads correctly ("edited after generating").
- [ ] Delete older versions: `DELETE /api/files/:id/versions/:versionId`.
  - Allowed for admins, or the version's `createdBy`. Old versions with no
    `createdBy` are admin-only.
  - The live version can't be deleted this way.
  - Add a trash button in the Documents version history list, with a confirm.
- [ ] In-editor version history:
  - `onRequestHistory` lists `/api/files/:id/versions`
  - `onRequestHistoryData` returns a signed per-version URL
  - `onRequestRestore` restores **as a new version**, so nothing is lost
- [ ] Store the callback's `history` / `changesurl` per version, so version
  history can highlight what changed.
- [ ] Tests: regenerate → new version; delete-version permissions; restore
  creates a version.

## Phase 3 — New documents, templates, signatures and stamps

- [ ] Bundle ONLYOFFICE's blank `new.docx`, `new.xlsx` and `new.pdf` (form)
  from `ONLYOFFICE/document-templates` (Apache-2.0; keep the license notice).
- [ ] `POST /api/documents/new`: blank or template, name, projectId, kind. It
  copies into storage with `createdBy` and returns the fileId.
- [ ] "New document" dialog:
  - type: Word / Excel / PDF form
  - start from: Blank or a template of that type
  - name
  - project: preselected inside a project, required on the main page
  - document type
  - then opens the editor
- [ ] Buttons on **Project → Documents** and the **main Documents page**.
  Command-palette actions "New Word document", "New spreadsheet" and "New PDF
  form".
- [ ] Settings → new admin-only **Document Templates** tab (the AIA Template tab
  stays):
  - add, rename and delete templates
  - templates open in the editor for changes
  - stored as a system file kind so they don't show up in project Documents
- [ ] Offer `docs/Template.docx` (letterhead) as a one-click starter template.
- [ ] Profile signatures under Settings → User Preferences → "My signatures":
  - upload several
  - name each one
  - pick a default
  - white background removed on upload
- [ ] One-time import of any browser-saved `pdfEditorSignatures` from the old
  editor.
- [ ] Company stamps: managed in the Document Templates tab (admins upload, with
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
