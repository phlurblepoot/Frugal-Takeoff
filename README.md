# Frugal Takeoff

A self-hosted construction takeoff and bid-management application. Import PDF plans, measure quantities directly on the drawings, generate proposals, manage site checklists with photos, and collaborate with your team in real time — all from a single web app you run on your own infrastructure.

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
  - [PDF editor](#pdf-editor)
  - [Spreadsheet editor](#spreadsheet-editor)
  - [Checklists](#checklists)
  - [Sharing](#sharing)
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
| **PDF editor**             | Open any PDF, annotate with freehand, shapes, text, images, and saved signatures. Reorder / delete / import pages. Save back to a PDF.                           |
| **Spreadsheet editor**     | Edit `.xlsx` printouts inline using Fortune Sheet — formulas, formatting, multi-sheet — then save over the original.                                             |
| **Checklists**             | Per-project punch lists with Before / In Progress / After photo sections, per-item comments, drag-to-reorder, and a printable PDF.                               |
| **Sharing**                | Generate expiring read-only share links for a single page, a set of pages, or a printout — recipients don't need an account.                                     |
| **Bid pipeline**           | Inbox of invitation-to-bid emails. Threading by subject, reply through SMTP, IMAP polling from multiple accounts.                                                |
| **Collaboration**          | Real-time cursors, presence, and per-page notes via Socket.io.                                                                                                   |
| **Users & permissions**    | JWT auth with bcrypt hashing, admin-managed users, per-user login attempt rate limiting with real-IP detection behind Cloudflare.                                |
| **Mobile friendly**        | One-finger draws, two-finger pans/zooms; toolbar and dock layouts adapt for phones and tablets.                                                                  |
| **Self-host**              | Single Docker image, SQLite for storage, no external services required.                                                                                          |

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

A `Dockerfile` and `docker-compose.yml` are included.

```bash
docker compose up -d
```

The container exposes port `3000` and mounts `./data` for the SQLite database, uploaded PDFs, images, and generated PDFs. Behind Cloudflare (or any reverse proxy that sets `X-Forwarded-For`), the rate limiter will correctly see the real client IP — the app trusts one proxy hop by default.

---

## First-time setup

On first launch:

1. Visit the app and you'll be redirected to `/login`.
2. The first registration creates an admin user.
3. Log in and open **Settings** to:
   - Set the app name and logo (replaces "Takeoff Pro" everywhere, including the sidebar and the proposal PDF header).
   - Set the **Public Host URL** so share links point to the right domain.
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

### PDF editor

Accessible from the side dock, the PDF editor is a full client-side annotation tool.

- **Open** any PDF from your computer, or open a saved printout from a project.
- **Draw** freehand, lines, arrows, rectangles, ellipses, text, and stamp images.
- **Signatures** — add a scanned signature; the tool removes the white background automatically. Saved signatures persist across sessions in browser storage.
- **Pages** — the sidebar shows a thumbnail for every page. Delete a page with the trash icon, reorder by dragging the grip handle (mouse or touch), or append new pages from a PDF file or image with the **+** button.
- **Save** writes back to the originating printout; **Save As** uses the File System Access API to open a proper save dialog where supported, and falls back to a direct download elsewhere.

![PDF editor](docs/screenshots/pdf-editor.png)

### Spreadsheet editor

For `.xlsx` printouts, click **Open in Spreadsheet Editor** to edit inline. Powered by Fortune Sheet — supports formulas, cell formatting, multiple sheets, and saves straight back over the original file.

### Checklists

Build punch lists per project with three photo sections per item:

- **Before** — site conditions before work.
- **In Progress** — work mid-way, for status updates.
- **After** — completed work.

Each item also has a **Comments** field for notes, blockers, or reasons the item isn't complete yet. Drag any item by its handle to reorder, including across the Pending / Completed divider. Print the checklist as a PDF — photos, comments, and in-progress shots all appear in the printout.

![Checklist editor](docs/screenshots/checklist.png)

### Sharing

Any page, a selection of pages, a printout, or an entire proposal can be shared with a read-only link. Recipients don't need an account.

- **Single page** — just that page's canvas with all takeoffs baked in.
- **Multiple pages** — one combined link that opens a vertical scroll gallery of every selected page.
- **Printout** — the raw PDF, served inline with a download button.

Share URLs use the **Public Host URL** configured under Settings, so the link is correct regardless of internal hostnames.

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

| Tab          | What lives here                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------- |
| **General**  | App name, logo URL, Public Host URL (used in share links).                                          |
| **Appearance** | Theme (light / dark), accent colour.                                                               |
| **Email**    | SMTP (outgoing) and IMAP (incoming) account configuration, poll interval, provider setup guide.     |
| **Users**    | Create / disable / delete users, set roles, reset passwords.                                        |
| **History**  | Recent changes — the in-app changelog for each released version.                                    |

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
- Fortune Sheet (spreadsheet editor)
- lucide-react (icons), motion (animations)
- Tesseract.js (OCR for page label detection)
- Google Maps React bindings (project location picker)

**Backend**

- Node.js 22 + Express 4
- better-sqlite3 (single-file database)
- Socket.io (real-time collaboration)
- nodemailer (SMTP send) + imapflow (IMAP poll) + mailparser
- JSON Web Tokens + bcryptjs

**Deploy**

- Docker (single-stage build on `node:22-bookworm-slim`)
- docker-compose for local / on-prem
- Cloud Run compatible (`APP_URL` is injected at runtime)

---

## Contributing

This repository follows a simple git workflow:

- `main` — production / stable
- `testing` — active integration branch; PRs to `main` are cut from here

PRs should target `testing`. For larger changes, the in-app changelog (rendered on the **History** tab under Settings) should be updated as part of the same PR.

Screenshots for this README live in `docs/screenshots/`. Replace the placeholders above with your own captures as the UI evolves.
