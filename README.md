# Frugal Takeoff

A self-hosted construction takeoff and bid-management application. Import PDF plans, measure quantities directly on the drawings, generate proposals, edit PDFs, Word files and spreadsheets together in the browser, manage site checklists with photos, and collaborate with your team in real time — all from a web app you run on your own infrastructure.

> The displayed app name is configurable — the default is **Takeoff Pro**, but it can be changed under Settings → General along with a custom logo.

![Projects dashboard](docs/screenshots/projects-dashboard.png)

---

## Contents

- [What is Frugal Takeoff?](#what-is-frugal-takeoff)
- [Feature overview](#feature-overview)
- [Running locally](#running-locally)
- [Docker deployment](#docker-deployment)
- [First-time setup](#first-time-setup)
- [Using the app](#using-the-app)
  - [Creating a project](#creating-a-project)
  - [The canvas: takeoffs and measurements](#the-canvas-takeoffs-and-measurements)
  - [Proposals and Excel export](#proposals-and-excel-export)
  - [Documents and the document editor](#documents-and-the-document-editor)
  - [Checklists](#checklists)
  - [Sharing](#sharing)
  - [Notifications](#notifications)
  - [Real-time collaboration](#real-time-collaboration)
  - [Bid pipeline and email](#bid-pipeline-and-email)
- [Settings](#settings)
- [Users and permissions](#users-and-permissions)
- [Tech stack](#tech-stack)
- [Contributing](#contributing)

---

## What is Frugal Takeoff?

Frugal Takeoff is an end-to-end workflow for small and mid-sized contractors who need to:

1. Receive an invitation to bid (by email or manually)
2. Import the drawings into a project
3. Measure quantities directly on the PDF
4. Price the takeoff with reusable item packages
5. Generate a branded proposal PDF and send it back to the client
6. Track the work with a site checklist (photos, comments, reordering)

Everything runs on your own server — there is no SaaS dependency, no external API calls for the core workflow, and your drawings never leave your infrastructure.

---

## Feature overview

| Area                       | What it does                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projects**               | Organise drawings into projects with client info, scope notes, status (draft / submitted / responded / accepted), and a location pinned on Google Maps.          |
| **PDF import**             | Drop in multi-page PDFs. Pages are rendered at 2× scale; sheet numbers and titles are auto-detected from PDF page labels, filenames, or OCR on repeated tokens. |
| **Takeoffs**               | Measure area, perimeter, linear feet, and counts directly on each page with calibrated pixel-to-unit scaling. Multi-segment shapes and merge support.            |
| **Price packages**         | Build reusable item packages (sub-items with quantities per sq ft / LF / unit) and apply them to measurements for instant pricing.                               |
| **Legends**                | Per-page or project-wide legend that lists each measurement with its colour swatch, quantity, and price — styled, resizeable, snap-to-corner.                    |
| **Proposals**              | Generate a branded multi-page PDF proposal with cover page, scope, optional takeoff list, optional cost detail, terms, and signature block.                      |
| **Excel export**           | Export takeoffs to `.xlsx` with the same columns and grouping as the Takeoffs tab, including advanced-pricing detail rows.                                       |
| **Document editor**        | Edit PDFs, Word files, spreadsheets and presentations in the browser with ONLYOFFICE Docs: several people at once, comments, @mentions, track changes and form filling. Phones open documents to read. |
| **Documents**              | Every project file in one place, with thumbnails, version history (restore, delete older versions), new documents from blanks or templates, personal signatures and company stamps, and old formats (.doc, .xls, Pages, Numbers…) converted on upload. |
| **Checklists**             | Per-project punch lists with Before / In Progress / After photo sections, per-item comments, drag-to-reorder, and a printable PDF.                               |
| **Sharing**                | Share any document, several documents under one link, or plan pages with a read-only link that lasts 7, 30 or 90 days, or never; stop sharing any time. Recipients don't need an account. |
| **Bid pipeline**           | The Projects list is a lifecycle board — Bidding, In Progress, and Archive as tabs, each with its own sort (bid due date, last updated, name, date added) and a "Recently opened" shortcut — so nothing needs to be re-triaged by hand as a project moves from bid to job to close-out.       |
| **Mail**                   | A full mailbox inside the app — each person connects Google Workspace, Microsoft 365, or any IMAP/SMTP host, and sends and replies from their own address, including straight from proposals, invoices, RFIs, and other project documents. Replies to a sent RFI show up as a pending answer to accept or dismiss. |
| **Collaboration**          | Real-time cursors, presence, and per-page notes via Socket.io.                                                                                                   |
| **Notifications**          | A bell for @mentions, tasks and RFIs, live in the app, and optionally as notifications on your phone or computer.                                                  |
| **Users & permissions**    | JWT auth with bcrypt hashing, admin-managed users, per-user login attempt rate limiting with real-IP detection behind Cloudflare.                                |
| **Mobile friendly**        | One-finger draws, two-finger pans/zooms; toolbar and dock layouts adapt for phones and tablets.                                                                  |
| **Self-host**              | Two Docker containers (the app, and ONLYOFFICE Docs Community Edition for documents), SQLite for storage, no external services required.                          |

---

## Running locally

**Prerequisites:** Node.js 22+ and a C toolchain (required by `better-sqlite3`).

```bash
git clone https://github.com/phlurblepoot/Frugal-Takeoff.git
cd Frugal-Takeoff

cp .env.example .env
# Edit .env to set APP_URL and, if you like, JWT_SECRET / DATA_DIR

npm install
npm run dev
```

The app is served from <http://localhost:3000>. The first boot auto-generates a JWT signing secret and persists it in the database, so you don't need to set `JWT_SECRET` unless you want a specific value.

### Scripts

| Script           | What it does                                        |
| ---------------- | --------------------------------------------------- |
| `npm run dev`    | Build the frontend on the fly and start the server. |
| `npm run build`  | Production-build the Vite frontend into `dist/`.    |
| `npm run lint`   | Type-check with `tsc --noEmit` (no output on pass). |
| `npm run clean`  | Remove the `dist/` build output.                    |

---

## Docker deployment

A `Dockerfile` and `docker-compose.yml` are included. The compose file runs two containers: the app, and **ONLYOFFICE Docs** (Community Edition, pinned to a tested version), which the app uses to edit and view documents.

```bash
# Once: a secret the two containers share
echo "ONLYOFFICE_JWT_SECRET=$(openssl rand -hex 32)" >> .env
# Set ONLYOFFICE_PUBLIC_URL in docker-compose.yml to ONLYOFFICE's HTTPS address
docker compose up -d
```

The app container exposes port `3000` and mounts `./data` for the SQLite database, uploaded files, versions, thumbnails and generated PDFs. Behind Cloudflare (or any reverse proxy that sets `X-Forwarded-For`), the rate limiter will correctly see the real client IP — the app trusts one proxy hop by default.

ONLYOFFICE needs its own HTTPS subdomain (browsers load the editor from it) and about 4 GB of RAM; it keeps nothing permanent, since documents live in the app's data folder. **[docs/onlyoffice-setup.md](docs/onlyoffice-setup.md)** walks through it on Unraid behind Cloudflare and Nginx Proxy Manager, including upgrading from a version without it. Without ONLYOFFICE everything else works, and documents can still be previewed and downloaded, but not edited.

---

## First-time setup

On first launch:

1. Visit the app and you'll be redirected to `/login`.
2. The first registration creates an admin user.
3. Log in and open **Settings** to:
   - Set the app name and logo (replaces "Takeoff Pro" everywhere, including the sidebar and the proposal PDF header).
   - Set the **Public Host URL** so share links point to the right domain.
   - Check **Document Editor** shows three green **Working** checks (see [docs/onlyoffice-setup.md](docs/onlyoffice-setup.md)).
   - Configure **Email** (SMTP + IMAP) if you want the bid-pipeline integration.
   - Invite additional users under the **Users** tab.

![Settings screen](docs/screenshots/settings.png)

---

## Using the app

### Creating a project

1. Click **New Project** on the projects dashboard.
2. Fill in the client, scope, and location (Google Maps search integrated).
3. Drop in one or more PDF drawings. Each page becomes a takeoff page.
4. For pages whose sheet number matches an existing page in the project, the page is flagged as a **REVISION** with an amber badge so you can review changes before they overwrite your takeoffs.
5. Confirm or edit the auto-detected sheet numbers and descriptions for each page.

![New project — PDF import](docs/screenshots/new-project.png)

### The canvas: takeoffs and measurements

Open any page to get the canvas editor. The left sidebar lists your measurements grouped by price package; the right panel holds page settings (scale, legend, rotation).

**Calibrating the page.** Click the calibration tool, click two points of known distance on the drawing (e.g. a dimension line), and enter the real-world length. The pixel-to-unit scale is saved per page.

**Measurement tools.**

- **Area** — click to place vertices, double-click to close. Reports square feet.
- **Line** — click two points for a linear measurement.
- **Count** — stamp a marker at a point; count rolls up in the sidebar.
- **Multi-segment** — after closing an area or finalising a line, the next click continues the same measurement. Use the **New Measurement** button to start a fresh one.
- **Multi-select + merge** — Ctrl-click (desktop) or the multi-select button (mobile) to select multiple measurements of the same type. A Merge button combines them into a single multi-segment measurement.

**Price packages.** In the right panel, create a package (e.g. "Concrete slab") with sub-items (Concrete Mix @ $14/unit, Rebar @ $0.80/LF, etc). Assign the package to measurements — totals update live. Advanced pricing is rolled up into the Excel export and proposal cost detail.

![Canvas view with takeoffs](docs/screenshots/canvas-view.png)

**Legends.** Toggle the legend on for individual pages, or project-wide under Settings. Legends snap to any corner, resize proportionally, and can be copied to every page with one click.

**Mobile.** On a phone or tablet, the sidebar hides and the canvas fills the screen. One-finger touch draws or places points; two-finger gesture pans and pinch-zooms simultaneously.

### Proposals and Excel export

From the project view, click **Generate Proposal**:

- Optionally include the takeoff list
- Optionally include the cost-detail breakdown (available only if the takeoff list is included)
- Add a personalised message and terms
- Proposal opens in a new tab — save or print

**Excel export** produces an `.xlsx` with Name / Type / Qty / Unit Cost / Total Cost columns, grouped by price package, with advanced-pricing detail rows underneath each item.

![Proposal PDF](docs/screenshots/proposal.png)

### Documents and the document editor

**Documents** (in the sidebar, and on each project's Documents tab) lists every file: uploads, printouts, proposals, invoices, pay apps, RFIs and photos, each with a thumbnail. Hover a row for a bigger preview; right-click for its actions.

**Editing.** Opening a PDF, Word file, spreadsheet or presentation starts the **document editor** (ONLYOFFICE Docs):

- Several people can edit the same file at once and see each other's changes. Comments, **@mentions** (the person is notified), track changes and PDF form filling all work.
- Each editing session saves **one new version**; the file as it was before stays in its history. Editing a generated document (an invoice, pay app, proposal…) keeps the generated original as a version, and regenerating always makes a new version.
- **Insert → Image → From storage** adds one of your signatures, a company stamp, a project photo or any other image in the app. **File → Save Copy as** (e.g. a PDF of a spreadsheet) saves the copy into the same project.
- On phones, documents open to read.
- The sidebar's **Document Editor** lists recently opened files, and opens one from Documents or from your computer (uploaded into a project you pick first).

**Versions.** A document's history (in Documents, or **Version history** inside the editor) lists every version with who made it. Restore any version (as a new version, so nothing is lost), download it, or delete older ones (admins, and whoever made that version).

**New documents.** **New document** on the Documents page, a project's Documents tab, or the command palette makes a blank Word file, spreadsheet or fillable PDF form, or starts from one of the templates admins keep under **Settings → Document Templates**.

**Signatures and stamps.** Everyone keeps their own named signatures, with a default, under **Settings → User Preferences → My signatures**; the white background is removed on upload. Admins upload company stamps (APPROVED, REVIEWED, a company seal…) under Document Templates, and anyone can insert them. ONLYOFFICE's own signature fields work too.

**Old formats.** An uploaded .doc, .xls, .rtf, .odt, .ods, .ppt, Pages, Numbers or Keynote file is converted to .docx, .xlsx or .pptx, and the original is kept as the previous version.

**AIA pay apps.** **Make PDF** in the pay app editor turns the workbook into a PDF, which is attached when you email the pay app.

**Viewer.** Word, Excel and PowerPoint attachments in Mail open read-only in a new tab, and share links show shared documents in the same viewer, on phones too.

### Checklists

Build punch lists per project with three photo sections per item:

- **Before** — site conditions before work.
- **In Progress** — work mid-way, for status updates.
- **After** — completed work.

Each item also has a **Comments** field for notes, blockers, or reasons the item isn't complete yet. Drag any item by its handle to reorder, including across the Pending / Completed divider. Print the checklist as a PDF — photos, comments, and in-progress shots all appear in the printout.

![Checklist editor](docs/screenshots/checklist.png)

### Sharing

Any document, several documents at once, a plan page, or a selection of pages can be shared with a read-only link. Recipients don't need an account.

- **A document** — right-click it in Documents (or use **Share** in its preview) and pick **Share…**. Word, Excel, PowerPoint and PDF files open in the document viewer (on phones too); anything else offers a download.
- **Several documents** — select them in Documents and click **Share** in the bulk bar. One link opens a list of them (up to 50); each opens the same way.
- **A plan page** — the link button on the page (or **Share page…** from its right-click menu). Just that page's canvas with all takeoffs baked in.
- **Several pages** — select them and click **Share**. One link opens a scrolling gallery of every selected page.

Each new link lasts **7, 30 or 90 days, or never expires** (30 by default); the share window shows when it expires and can change it. A document's share window lists every link that opens it, including several-documents links it is part of, with **Stop sharing** on each. Someone opening an expired or stopped link is told which, rather than getting an error. Links made before expiry existed never expire, but can still be stopped.

Share URLs use the **Public Host URL** configured under Settings, so the link is correct regardless of internal hostnames.

### Notifications

The **bell** in the sidebar, next to who's online, rings when someone @mentions you in a document comment, assigns you a task or an RFI, or when a GC answers an RFI you sent or own. Clicking one opens what it's about.

Each person can also get them as **phone notifications**, turned on per device under **Settings → User Preferences → Phone notifications** (on iPhone, from the app added to the Home Screen). See [docs/onlyoffice-setup.md §9](docs/onlyoffice-setup.md#9-phone-notifications).

### Real-time collaboration

When two or more users open the same project or page:

- See each other's cursor in real time
- Presence badges at the top of the canvas show who's currently viewing
- Pin text notes to any location on a page; notes are visible to everyone on that page

Collaboration runs over Socket.io — no extra services required.

### Bid pipeline and email

Configure one or more IMAP accounts under **Settings → Email** and the app will poll for new messages on an interval you choose (5 min – 1 hr, or poll manually). Bid invitations show up in the **Bid Pipeline**:

- Messages are threaded by subject (`Re:` / `Fwd:` prefixes stripped)
- The latest message is auto-expanded; older messages collapse
- HTML emails render with formatting in a sandboxed iframe
- Reply directly from the pipeline using your configured SMTP account — the reply threads correctly into the original conversation

Provider presets for Gmail, Outlook, Yahoo, and iCloud autofill the server details when you add an account, and the Email Provider Setup Guide links to each provider's app-password page.

![Bid pipeline](docs/screenshots/bid-pipeline.png)

---

## Settings

The **Settings** page has the following tabs:

| Tab                    | What lives here                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| **User Preferences**   | Dark mode, accent colour, password, **My signatures**, **Phone notifications**.                                |
| **Takeoff Templates**  | Reusable takeoff templates.                                                                               |
| **General Settings**   | App name, logo URL, Public Host URL (used in share links). Admins only.                                   |
| **Mail**               | Connecting your mailbox; server setup guide.                                                              |
| **Storage**            | Disk use by projects and file types. Admins only.                                                         |
| **Backup**             | Snapshots of the database and files, and restoring them. Admins only.                                     |
| **Document Editor**    | ONLYOFFICE's addresses, version and three connection checks, with what to fix when one fails. Admins only. |
| **Document Templates** | Templates for **New document**, and company stamps. Admins only.                                          |
| **AIA Template**       | The workbook layout for AIA pay apps. Admins only.                                                        |
| **User Management**    | Create / disable / delete users, set roles, reset passwords. Admins only.                                 |
| **Changelog**          | Recent changes — the in-app changelog for each released version.                                         |

---

## Users and permissions

- Passwords are hashed with bcrypt.
- Sessions use JWTs signed with a secret auto-generated on first boot (persisted in the database).
- Public endpoints (`/api/settings`) strip `smtp.*` and `jwt.*` values before serving them to unauthenticated callers.
- Login attempts are rate-limited per client IP. Behind Cloudflare or another proxy, the first `X-Forwarded-For` hop is trusted so buckets are per real user, not per proxy.

---

## Tech stack

**Frontend**

- React 19 + TypeScript + Vite
- Tailwind CSS 4
- Konva / react-konva (canvas annotations)
- pdfjs-dist (PDF rendering) + pdf-lib (PDF writing)
- jsPDF (proposal / checklist generation)
- ONLYOFFICE Docs API (document editor and viewer)
- lucide-react (icons), motion (animations)
- Tesseract.js (OCR for page label detection)
- Google Maps React bindings (project location picker)

**Backend**

- Node.js 22 + Express 4
- better-sqlite3 (single-file database)
- Socket.io (real-time collaboration and live notifications)
- nodemailer (SMTP send) + imapflow (IMAP poll) + mailparser
- JSON Web Tokens + bcryptjs
- web-push (phone notifications), sharp (photo thumbnails), ExcelJS / SheetJS (workbooks)

**Deploy**

- Docker (single-stage build on `node:22-bookworm-slim`)
- ONLYOFFICE Docs Community Edition (`onlyoffice/documentserver`, pinned) as a second container
- docker-compose for local / on-prem
- Cloud Run compatible (`APP_URL` is injected at runtime)

---

## Contributing

This repository follows a simple git workflow:

- `main` — production / stable
- `testing` — active integration branch; PRs to `main` are cut from here

PRs should target `testing`. For larger changes, the in-app changelog (rendered on the **History** tab under Settings) should be updated as part of the same PR.

Screenshots for this README live in `docs/screenshots/`. Replace the placeholders above with your own captures as the UI evolves.
