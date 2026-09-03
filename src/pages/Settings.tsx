import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { Globe, Image as ImageIcon, Users, History, User, Palette, Sun, Moon, Check, Zap, ZapOff, Save, Link, Mail, Trash2, RefreshCw, CheckCircle, HardDrive, Sparkles, FileSpreadsheet, Lock, Loader2, Layout, Tag, Plus, Pencil, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { getSettings, saveSettings, getStorageStats, formatBytes, StorageStats, getStorageOrphans, cleanupStorageOrphans, saveBinaryFile, getAuthHeaders, getDocumentTypes, saveDocumentTypes, getDocuments, CustomDocType } from '../utils/store';
import { UsersView } from './UsersView';
import { MailAccountsTab } from './settings/MailAccountsTab';
import { TemplatesView } from './TemplatesView';
import { useTheme, AccentKey } from '../context/ThemeContext';
import { getAiStatus, aiAutoNameEnabled, setAiAutoNameEnabled, type AiStatus } from '../utils/aiSheets';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';

// ── Changelog data ────────────────────────────────────────────────────────────

interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    version: '2.11.0',
    date: 'September 3, 2026',
    changes: [
      'A mail thread can now be linked straight to a project, a customer, or a specific item — "+ Link" in the conversation opens a picker (Customer / Project / drill into a Task, RFI, Issue, Invoice, Change Order, Pay App, Proposal, Daily Report, or Punch List) and the link shows up everywhere as a real label ("RFI-012", "INV-104") instead of just the item type. Unlink your own links any time; admins can unlink anyone\'s.',
      '"Create ▾" on a conversation turns it straight into a Task, RFI, or Issue — the new item is pre-filled with the thread\'s subject and the latest message\'s text, linked back to the conversation automatically, and opens right in its editor.',
      'Opening a linked conversation now works for everyone on the job, not just whoever\'s mailbox it lives in: if it\'s not in your own mail, you get a read-only reference card (subject, participants, date, and what it\'s linked to) instead of a dead end.',
      'A "Reply" indicator now shows up anywhere a sent document is tracked — invoices, change orders, proposals, issues, RFIs, daily reports, pay applications, and tasks — the moment an email comes back on its thread that nobody has looked at yet.',
      'Projects gained a Mail tab: every email conversation linked to that project or one of its items, in one list, with who\'s in it, what it\'s linked to, and a reply indicator — no more hunting through a mailbox to find where a thread went.',
      'Editing an IMAP mail account now starts from what\'s already saved (host, port, username) instead of a blank form.',
      'Fixed: a reply landing on an RFI\'s thread no longer flips its document to "PDF out of date" — arriving mail isn\'t a change to the record.',
      'Fixed: switching threads, folders, or mailboxes while a reply is still being typed now asks before discarding it.',
      'The mail conversation list now scrolls smoothly in very large folders (150+ threads) by only keeping the visible rows on screen.',
    ],
  },
  {
    version: '2.10.0',
    date: 'August 30, 2026',
    changes: [
      'Email now lives in the app. Each person connects their own mailbox — Google Workspace, Microsoft 365, or any IMAP/SMTP host — and the server keeps it indexed in the background, so new mail shows up within seconds on Microsoft and IMAP, and within about half a minute on Gmail.',
      'New Mail tab: a full mailbox inside the app — folders down the left, conversations in the middle, the thread on the right. Read, star, archive, move and trash mail; search across a mailbox; and write with formatting, attachments (uploaded or picked from Documents), reply, reply-all and forward. A message you are part-way through saves itself as a draft, and threads that came from a project record are chipped with what they belong to.',
      'Any attachment on a message can be filed straight into Documents with \'Save to Documents…\' — pick the document type and the project it belongs to, and it lands in the list like any other file.',
      'Settings → Mail is where mailboxes live: connect Google Workspace or Microsoft 365 with a Connect button (no password stored) or fill in any IMAP/SMTP host, give each account its own signature, pick which one sends by default, and remove ones you no longer use.',
      'Sending from proposals, invoices, change orders, issue reports, RFIs, daily reports, punch lists and pay applications now goes out through your own connected mailbox, in the same composer as the rest of the app — so the recipient sees it from you, and it lands in your Sent. Once a document has been emailed, its editor shows a \'Sent · Open thread\' chip that jumps to the conversation, replies and all.',
      'Gmail can now deliver mail in real time instead of waiting for the next check: an admin creates a Google Cloud Pub/Sub topic and points it at the app (Settings → Mail → Server setup guide has the exact steps and URL). It is optional — Gmail keeps checking on a timer either way — and Microsoft and IMAP accounts already arrive instantly.',
      'Note for self-hosters: your old SMTP settings have been migrated into a mail account that starts as "Needs review", and nothing sends until you activate it — open Settings → Mail, confirm the IMAP host and password, and test the connection. Google and Microsoft sign-in also needs a one-time server setup by an admin (see docs/mail-setup.md). This update includes a data-transforming migration (31) plus an additive index (32) — back up before pulling, and keep the new data/mail.key file with your data directory.',
      'RFIs now watch for a reply: when an email comes in on the thread of an RFI you sent, it shows up as a banner on that RFI (and a chip in the RFI list) offering to use it as the response, attachment and all — nothing is recorded automatically, so a reply that isn\'t actually the answer can just be dismissed.',
    ],
  },
  {
    version: '2.9.0',
    date: 'August 29, 2026',
    changes: [
      'One shared document strip now covers every generated PDF/Excel in the app — invoices, change orders, issue reports, punch printouts, RFI responses, daily reports, proposals, and AIA pay applications — showing whether a document exists and is current ("No PDF yet" / "PDF up to date" / "PDF out of date"), with Generate, Open, Download, and Email all in one place. Regenerating a document that already exists always asks first: save as a new version (keeping the old one as history) or overwrite it.',
      'The old "Download PDF" buttons are gone: you now press Generate to build and store the document, then Open it in the viewer or Download it — so the same document the customer gets is the one filed under Documents, instead of a fresh copy every time.',
      'Emailing a document reuses the stored file when it is still current, and rebuilds it first when the record has changed since (or when you pick a different reply-to address). The punch list report has no per-item change history to check, so it always regenerates before sending.',
      'Re-sending a document that was already sent no longer changes its status — in particular, emailing a paid invoice a second time no longer knocks it back to "sent", and a re-send no longer marks its own PDF as out of date.',
      'Recording or deleting a payment, and editing the schedule of values, now mark the related documents out of date: an invoice or pay-application PDF prints Paid and Balance, and every pay application is calculated from the schedule of values, so the status chip flags them for regeneration instead of quietly emailing stale figures.',
      'One shared "Add files" button now covers every photo grid and attachment list — issue/punch/daily-report photos, proposal photos and attachments, RFI responses — letting you upload fresh files or pick from the project\'s existing documents from the same picker, with drag-and-drop support.',
      'Note for self-hosters: this update includes an additive migration (30) that adds an updatedAt column to invoices, change orders, issues, RFIs, and pay applications, so the new document status chip can tell when a record has changed since its last generated document.',
    ],
  },
  {
    version: '2.8.0',
    date: 'August 28, 2026',
    changes: [
      'Proposals reworked into first-class, numbered project records: multi-line pricing that mixes takeoff-derived lines with hand-typed manual lines, an Alternate flag per line with its own subtotal, an optional grand-total, inclusions/exclusions lists, an optional payment schedule, photos with captions, and existing-PDF attachments (upload or pick from the project\'s documents). Revising a proposal clones it into a new numbered draft (e.g. "#2 (rev. of #1)") with the choice to carry photos and attachments along, and the original stays exactly as sent. Accepting a sent proposal can attach a signed copy and offer to prefill the schedule of values from its lines; declining is one click. Proposals live under a new Proposals section per project (admin-only), and the Dashboard gained an "Outstanding proposals" card for sent-but-unanswered proposals sorted by expiry.',
      'Takeoff Print and Excel exports moved off the old proposal page: selecting takeoffs on the Takeoffs tab and printing/exporting now saves the result straight into the project\'s Documents list (as a Takeoff Print / Takeoff Export document) instead of living on a proposal. The Proposal button on that same toolbar starts a new proposal pre-seeded with the selected takeoffs.',
      'New shared "choose an existing file" picker (used by proposal photos/attachments) lets you search and filter the project\'s documents instead of only uploading fresh ones.',
      'Documents gained a "Company document" type for files that aren\'t tied to any project — the upload popup\'s Project and Customer fields both grey out and clear for that type.',
      'Note for self-hosters: this update includes a data-transforming migration (28) that converts every project\'s old proposal history (stored printouts, sent PDF, photos, cover notes/terms) into the new numbered proposal records and relabels old takeoff printouts as Documents entries — back up before pulling this update. A second, additive migration (29) adds a per-project proposal-numbering counter so a deleted proposal\'s number is never reused.',
    ],
  },
  {
    version: '2.7.2',
    date: 'August 27, 2026',
    changes: [
      'Improved: the recent-activity feeds (Dashboard and project Overview) now show the project name on each entry, and clicking an entry jumps to the page it happened on — an RFI event opens that project’s RFIs, a payment opens Billing, and so on. Billing entries only link for admins, since Billing is an admin-only section.',
      'Fix: Project Settings no longer saves while you type. Fields kept auto-saving on every change, which briefly disabled the inputs (losing your cursor) and let live-refresh swap the page mid-edit. Details and contacts now commit with an explicit Save button (with a Discard option), and other users’ screens refresh when you save — not on every keystroke.',
      'Fix: on the daily report form, the man-count description box is now the wide one and the count box the narrow one (they were flipped).',
    ],
  },
  {
    version: '2.7.1',
    date: 'August 26, 2026',
    changes: [
      'New: Daily Reports tab on every project — one report per work day with crew man-counts, field notes, and issues; weather auto-fills with the actual hourly conditions for the day when the project has an address (editable). Reports print/email on the company letterhead with photos attached, and long sections continue cleanly onto a second page.',
    ],
  },
  {
    version: '2.7',
    date: 'August 26, 2026',
    changes: [
      'Real-time collaboration, app-wide: changes other users make (projects, pages, takeoffs, billing, issues, tasks, documents, and more) now appear on your screen live — no refresh needed — and the app warns you when someone else is editing the same thing so you never silently overwrite each other.',
      'Online users list now shows every session per user (each computer/tablet/phone, with an automatic device label), and a Follow button lets you follow a teammate to whatever page they are on.',
      'Canvas drawing rebuilt on server-applied operations: measurements sync live between users, late joiners catch up automatically, page scale and takeoff changes update open canvases in real time, and superseded plan revisions are fully read-only.',
      'Spreadsheet editor rebuilt Google-Sheets-style: opens the real file from Documents with full formatting, edits together live (shared cursors and cell presence), autosaves straight to the file about every 15 seconds (no Save button), and archives a version snapshot of the file as it was before each editing session. Renaming, adding, deleting, and reordering sheets are all safe, and the autosave chip tells you honestly if saving ever fails.',
      'Plan pages you have already viewed are cached in the browser — flipping back and forth between pages is now instant, with a thumbnail preview and download progress while a page loads.',
      'Note for self-hosters: this update adds two new database tables for live spreadsheet sessions (migration 26, additive — existing data untouched).',
    ],
  },
  {
    version: '2.6.1',
    date: 'August 19, 2026',
    changes: [
      'Fix: the Documents page now loads fast on servers with a large number of files. The file list was re-checking every plan page for every document on each load; a database index fix makes that check instant (measured ~2.7 seconds → 6 milliseconds on a 20,000-file test database).',
    ],
  },
  {
    version: '2.6',
    date: 'August 17, 2026',
    changes: [
      'Customers are now the front door: the Customers section is a split view — customer list on the left, and a full landing page per customer on the right with Overview, Projects, Tasks, Billing, and Settings tabs. The Overview surfaces things needing attention (past-due bids, overdue tasks, outstanding money) and Billing rolls up every project\'s contract and payment picture in one place.',
      'Simpler project stages: the Projects board is now two working stages — Bidding and In Progress — plus Archived. Finishing (or losing) a job archives it, and lost bids carry a marker so win/loss history is preserved. Existing projects were moved to the matching stage automatically.',
      'New unified Documents page: a global Documents section lists every file across all projects — uploads, generated invoices, pay apps, change orders, proposals, reports, and photos — each labeled with its type and a link to where it came from. Filter by multiple types/projects/customers at once, multi-select to download or archive, and re-generated documents version instead of duplicating. Admins can define custom document types in Settings, and uploads get a labeling popup (type, customer, project, multiple files at once). Row actions moved to a right-click menu.',
      'Live document previews: hovering a row on the Documents page pops a small preview beside the cursor — photos show the image, PDFs show their first page, all after a short delay so scanning the list stays fast. Clicking a row opens a full preview window with page-by-page PDF navigation, spreadsheet preview, and Download / Open in editor / Source / Archive buttons. (Opening the underlying editor moved to the "Open in editor" button.)',
      'AIA retainage, reworked: set one base retainage rate in Billing → Settings, or switch to per-line rates on the schedule of values. Pay applications can now release retainage in percentage points — release part of it on one application (the remainder carries forward automatically) or hit "Release all" on the final application. Excel exports reflect the effective rates either way.',
      'Clearer billing totals: project cards and customer billing now show two separate rows — Contract (contract total, billed via pay applications, outstanding, paid) and Invoices (invoiced, paid) — instead of one blended number. Figures no longer include drafts.',
      'Balances on every invoice and pay application: the Invoices and Pay Applications tabs gained Amount and Balance columns, and opening an invoice or pay app now lists the payments recorded against it.',
      'Change orders now have a title: shown as a new column in the Change Orders tab and used as the line description when approved change orders sync to the schedule of values.',
      'Fix: uploading documents from another device on the local network no longer fails immediately with an error.',
      'Proposal Cover notes and Terms & Conditions are now remembered: each project keeps what you last generated or sent, new projects prefill with your most recent text, and a history button beside each box offers your last 5 entries to fill with one click (per account, so it follows you across devices).',
      'The proposal page\'s redundant "Header color" picker is gone — proposals follow the Document brand color from Settings, the same as every other generated document.',
    ],
  },
  {
    version: '2.5',
    date: 'August 15, 2026',
    changes: [
      'New Subtract tool for area measurements: cut window and door openings straight out of an area. Select an area measurement, pick Subtract (next to Area, on phone too), and draw the opening — the hole shows the plan through it with a dashed outline, the sidebar lists each cutout as a deduction (e.g. −12.50 sq ft), and every total (canvas, legend, proposal, printouts) uses the net area. Cutouts edit like any segment: drag vertices, move them, undo/redo, and they carry forward across plan revisions.',
      'Fix: printing takeoffs on large plan sets no longer hangs forever or fails. Printouts and proposals were silently rejected by a server upload limit once the PDF got big (about 24+ sheets on heavy plan sets); saves now stream directly without that ceiling, and any failure shows an error message instead of an endless "Generating PDF" spinner. The same silent-hang bug was also fixed in the Excel export.',
      'New Email-ready quality option when printing or generating proposals: keeps the final PDF under 18MB so it clears the ~25MB attachment limits of Gmail/Outlook after email encoding. Small jobs pass through untouched at full quality; big ones are compressed page by page just enough to fit, and if a huge set still can\'t fit at readable quality it saves anyway and warns you with the actual size. The old Full/Large/Standard/Compact choices (which no longer did anything) are gone — it\'s now just Best quality and Email-ready.',
      'Printout downloads are faster and printout files no longer clutter the project Documents list — printout history lives in the Proposal section as before.',
    ],
  },
  {
    version: '2.4',
    date: 'August 11, 2026',
    changes: [
      'Page naming is now yours, not guessed: uploaded plan pages arrive numbered simply 1, 2, 3, … instead of the app trying to auto-detect sheet numbers and titles (which often guessed wrong). All naming happens in the naming window — type it, extract it from a selected region, or use AI Scan. Pages added to an existing set continue numbering after the set\'s highest number, so placeholders never collide.',
      'AI can read just the region you select: the extract tool has a new engine switch — Text/OCR (as before) or AI read, which sends only your selected rectangle to the local AI model and uses exactly the text it sees for the page number or description. Works on one page or across all pages at once, with progress shown. (Needs the AI model available on the server, like AI Scan.)',
      'Clearer "still needs naming" cues: pages that haven\'t been given a real name show an amber Needs-review badge in every naming flow (not just revision review), and the green check only appears once a page is actually named.',
      'Extract All Pages now refreshes revision matching automatically — extracted page numbers immediately re-link new pages to the sheets they revise, without pressing "Re-match by page #".',
      'Fix: printed highlight pages could shift all measurements diagonally on some plan sheets (PDFs from certain CAD tools that place the page origin at the sheet center). Printouts, proposal plan appendices, and PDF-editor saves now place overlays exactly where they were drawn. Regenerate any affected printouts.',
    ],
  },
  {
    version: '2.3',
    date: 'July 30, 2026',
    changes: [
      'RFIs (new): every project now has an RFIs section for formal Requests For Information. Write the question with spec/drawing references, who it\'s directed to, and a response-needed-by date; attach site photos; then download a branded RFI PDF or email it straight to the GC/architect. When the answer comes back, attach the response PDF (or type the response) and the RFI is marked answered — the list highlights overdue RFIs in red until then. RFIs move through Open → Sent → Answered → Closed.',
      'RFI numbers are permanent: RFIs are numbered RFI-001, RFI-002, … per project, and a number is never reused — even if an RFI is deleted — so the numbers you reference in correspondence stay unambiguous.',
      'Download SOV before billing starts: the Billing → Schedule of Values tab now has a "Download SOV" button that exports the standard AIA G702/G703 Excel with all billing at $0 — for presenting the schedule of values for approval before the first pay application. Uses your uploaded AIA template when one is configured.',
      'Fix: AIA Excel exports no longer show a #DIV/0! error in the change-order totals % cell on projects with no change orders.',
      'Tasks now relate to projects and customers: a task can be linked to the project or customer it\'s about (picking a project fills in its customer automatically). Project and customer pages have a Tasks link showing just their tasks, the global task list can be filtered by project or customer, and upcoming task deadlines appear on the Dashboard and on each project\'s Overview.',
    ],
  },
  {
    version: '2.2',
    date: 'July 1, 2026',
    changes: [
      'Plan sets reworked: each sheet now has one living set of measurements that carries across revisions. When you add a new revision of a sheet, its current measurements (and scale) are copied onto the new revision automatically — you no longer end up with duplicate measurements, and the older revision becomes read-only history you can still open and view.',
      'Correct totals & printouts: takeoff totals, printouts, and proposals now count only the current revision of each sheet, so measurements are never double-counted across revisions.',
      'Read-only revision history: opening a superseded revision shows a banner and blocks drawing, dragging, editing, or deleting measurements (with a one-click "Go to current"). Revisions can be compared in an enlarged full-screen overlay with pan/zoom and opacity.',
      'No duplicate pages in a set: naming two pages with the same page number within one plan set is now blocked, with a one-click option to auto-suffix the duplicate (e.g. "A-1 (2)").',
      'More reliable page-name extraction: the extract tool now reads both the PDF\'s embedded text and an OCR pass of the selected area and reconciles them, so garbled or image-only title blocks are matched far more reliably.',
      'AIA export matches your template: the default G702/G703 Excel export now mirrors the standard Big Bear AIA template, with contract line items and change-order items in separate sections that scale to fit however many rows you have.',
      'Branded documents: generated PDFs (proposals, invoices, change-order requests, issue reports, punch lists) now carry a branded header and footer. Set your company brand colour and choose whether to invert your logo for the dark banner under Settings.',
    ],
  },
  {
    version: '2.1.2',
    date: 'June 24, 2026',
    changes: [
      'Per-user email (SMTP): outgoing email is now configured per user instead of one shared account. Set up your own sending account under Settings → Email, and the proposals, invoices, issue reports, and change-order requests you send go out from your account. (Each user needs to enter their own SMTP settings once.)',
      'New project: plan PDFs are now optional — you can create a project with no pages and add them later. When you do upload PDFs, the upload step now shows a progress bar (and a working indicator while it reads the file) so you can tell it\'s processing and not stuck.',
      'Takeoff templates moved: the Templates tab was removed from the projects page and is now a "Takeoff Templates" section under Settings, which fits better now that projects are more than just takeoffs.',
      'Fixed text-field colours in dark mode on the new-project page (bid due date, plan set, and address fields were styled inconsistently).',
    ],
  },
  {
    version: '2.1.1',
    date: 'June 17, 2026',
    changes: [
      'Custom accent colour: in addition to the preset accent colours, you can now pick any custom colour for the app accent (User Preferences → Accent Colour). The chosen colour is applied across buttons, links, and highlights.',
      'Preferences now follow your account: your appearance settings (dark mode, accent colour including a custom colour, reduced motion) and the project-list sort are saved to your account and applied automatically when you log in on any device — no more re-setting them on each new computer.',
      'User roles: admins can now change a user\'s role (User ⇄ Admin) directly from Settings → User Management. The last remaining admin can\'t be demoted, and you can\'t change your own role.',
      'Change password: every user can now change their own password from Settings → User Preferences (enter your current password, then the new one).',
      'Projects page: the project stages (Estimating, Proposal Sent, Awarded, In Progress, Punch List, Complete, Lost) are now tabs across the top instead of stacked sections, each showing its count — so the board is easier to scan and the selected stage is remembered in the URL.',
    ],
  },
  {
    version: '2.1',
    date: 'June 15, 2026',
    changes: [
      'Email everywhere: invoices, change orders, issue reports, and proposals now open a full email composer instead of a single "To" box. You get a To field with an "Add Cc/Bcc" option, an editable subject and message (both prefilled with a sensible default for the document), and the ability to attach extra files alongside the generated PDF.',
      'Proposals — set price: you can now create a proposal with a fixed lump-sum price instead of pricing from takeoff measurements, for jobs quoted from a site visit. Switch the proposal to "Set price", enter the total, and describe the scope in the cover notes — the proposal PDF shows your price with no takeoff table.',
      'Proposals — photos: attach site photos to a proposal. They are saved on the project and appended to the generated proposal PDF as extra pages.',
      'Proposals — send by email on any project: the "Send proposal" option is now available on every project, not just ones created from an incoming bid email. Proposals created from a bid email still send as a threaded reply.',
      'Project list organization: the projects board now has a separate group for each stage (Estimating, Proposal Sent, Awarded, In Progress, Punch List, Complete, Lost) instead of three lumped groups; a sort control (last updated, date added, name, or bid due date) that is remembered; a "Recently opened" row at the top for quick access; and the bid due date now shows only on projects that are still in the estimating stage.',
      'Fix: saving SMTP email settings failed with a "save failed" error — the secure/port values weren\'t stored correctly. Saving now works, so outgoing email can be configured.',
    ],
  },
  {
    version: '2.0',
    date: 'June 15, 2026',
    changes: [
      'Major release. Frugal-Takeoff is now a full project workspace, not just a takeoff tool. Every project has its own sections — Overview, Pages, Takeoffs, Documents, Billing, Issues, Punch, Tasks, Proposal, and Settings — reachable from a redesigned app shell with a project sidebar, a global command palette (press ⌘K / Ctrl-K), and a refreshed light/dark design system used consistently across the app.',
      'Billing suite: each project now has a dedicated, tabbed Billing area. Create and send invoices with line items and a PDF; record payments against invoices or pay applications; and manage change orders. A live summary keeps the contract total, invoiced, paid, and outstanding figures at a glance.',
      'AIA progress billing: full G702 / G703 support. Build a Schedule of Values (seed it from the estimate, sync approved change orders, or upload a two-column spreadsheet), create monthly Applications for Payment with per-line % complete, stored materials, and retainage, and export faithful AIA G702/G703 Excel documents to send with each month\'s billing.',
      'Change Orders (new): a change order now opens an editor like an invoice — line items, a lump-sum amount, a description, schedule-impact days, and photo attachments. Generate a "Change Order Request" PDF (with an owner/contractor signature block and the photos appended as pages) and email it to the client. Change orders move through Draft → Sent → Approved/Rejected, and approved change orders flow into the contract total and the AIA Schedule of Values.',
      'Issues: log numbered deficiency reports against a project with photos, then generate a printable PDF or email the report to the client.',
      'Punch lists: build area-grouped punch lists with before/during/after photos and a printable punch report.',
      'Tasks: collaborative, assignable task lists replace the old per-project checklists, with assignees and completion tracking.',
      'Proposals: assemble and generate a project proposal PDF from your takeoffs and options, with a saved history of generated proposals.',
      'Documents: every project has a document library with drag-to-upload, file versioning (each re-upload keeps prior versions), filtering, and download — generated invoices, proposals, and change-order requests are filed here automatically.',
      'Dashboard & project lifecycle: a new dashboard summarizes activity, and projects move through clear lifecycle stages (estimating, active, complete, archived) with archive and cleanup tools.',
      'Mobile & tablet: the entire app is now usable on phones and tablets — a slide-in navigation drawer, responsive layouts and tables throughout, and touch-friendly controls. On the takeoff canvas, phones get a clean read-only view while tablets support touch drawing (pinch-zoom, double-tap to finish a measurement, long-press for the action menu).',
      'Foundation & reliability: rebuilt on a normalized database with versioned, automatic migrations and a safe backup/restore + cutover toolchain, plus a large automated test suite (unit + end-to-end) guarding the takeoff canvas, exports, and billing math. Money is handled in exact integer cents throughout, and concurrent edits are protected against conflicts.',
    ],
  },
  {
    version: '1.2.1',
    date: 'May 21, 2026',
    changes: [
      'Printouts: takeoff highlights and the legend are back on rotated sheets. After the move to the vector printout pipeline, any page with PDF rotation — the landscape sheets common to plan sets — came out as the bare page with no measurements or legend, because the overlay step skipped rotated pages. The overlay is now composed in each page\'s displayed orientation and mapped into its content space, so highlights, measurement labels, and the legend land correctly on rotated and unrotated pages alike.',
    ],
  },
  {
    version: '1.2',
    date: 'May 18, 2026',
    changes: [
      'Vector PDF pipeline (project pages): uploaded PDFs are now kept in storage and used as the source for the canvas, printouts, and search. Pages on the canvas render directly from the original PDF on demand and re-render at higher resolution when you zoom in — no more blurry stretched JPEGs at high zoom. Printouts copy the original vector page and stamp measurements / legend on top with pdf-lib, so the exported PDF is a fraction of the previous size and stays crisp at any zoom (measurement labels, legend text, and lines are real vector content now).',
      'Vector PDF pipeline (PDF editor): the standalone editor also stopped storing rasterised pages — it renders each visible page on demand from a live pdf.js document. Sharper text at every zoom, much smaller IndexedDB footprint, and the cached-page JPEG bug that produced fuzzy zooms is gone.',
      'Upload: the source PDF is streamed to the server as binary instead of being base64-encoded in the browser, fixing the out-of-memory crashes large plan sets used to trigger on the new-project upload step.',
      'Upload: OCR only runs on pages that genuinely need it. Text-bearing PDFs (CAD output) get their sheet number / description / search text from the embedded text layer directly, which is both faster and accurate to the character. Image-only or scanned PDFs still fall back to Tesseract.',
      'Page-number / description extraction: drawing a region in the preview modal now pulls text out of the PDF\'s embedded text layer first and only falls back to OCR when the region is image-only. Codes like "A5.0" come back as "A5.0", not the old OCR misread "AS.0".',
      '"Extract All Pages" no longer produces gibberish on non-previewed pages. For vector pages it reads the embedded text per page; for image-only pages it renders the full page at full resolution before OCRing the crop, instead of cropping a 400 px thumbnail.',
      'Page-naming preview: the modal now renders the original PDF page at full quality through pdf.js instead of zooming a small thumbnail. Same modal is shared between new-project upload and the add-pages-to-existing-project flow, so any future fix to either one lands in both at once.',
      'Project search: the cached page text used by the search bar is backfilled from each page\'s source PDF on first open, replacing the upload-era OCR string with the real embedded text. One-shot per page; legacy projects without a source PDF keep working with their existing text.',
      'Canvas: cross-page references are now clickable. If a page\'s embedded text contains another sheet\'s page number (e.g. an "A5.0" inside an elevation\'s section marker), it appears as a faint blue hotspot — pan-mode click takes you to that page. In any other tool the hotspot stays visible as an indicator but doesn\'t intercept clicks, so it can\'t hijack a measurement.',
      'Project page UI: the search bar has a clear button on the right that appears once you type, and pressing Esc inside the box also clears. A "X of Y pages" badge sits below the input while a term is active. Matched substrings in titles and snippets are highlighted in yellow.',
      'Project page UI: press / anywhere on the Pages tab to focus the search box (skipped if you\'re already typing into a different input).',
      'Project page UI: new sort dropdown — Page number (default, numeric), Description (descriptions without one sink to the bottom), or Most highlights first. Choice is persisted per user.',
      'Project page UI: new grid / list view toggle. List view shows a small fixed thumbnail and the full page name with no truncation, so long descriptions stay readable. Also persisted per user.',
      'Project page UI: right-click a page tile or row for a context menu with Open, Open in new tab, Add/Remove favorite, Copy share link, Rename, and Delete page.',
      'Project page UI: pages can be marked as favorites with the star button on the tile or the context menu. Favorites are per-user, per-project, and always sort to the top inside whichever sort mode is active so the sheets you revisit most are one glance away.',
      'Printouts on legacy projects continue to work — pages without a source PDF transparently fall back to embedding the stored raster as before. No data migration required to adopt this release.',
    ],
  },
  {
    version: '1.0.9',
    date: 'May 13, 2026',
    changes: [
      'Page naming OCR: switched to Tesseract\'s high-accuracy "tessdata_best" model for all sheet-number and description extractions — noticeably fewer garbled reads on stylised architectural fonts.',
      'Page naming OCR: added position-aware digit correction — in the numeric body of a sheet number, common letter/digit misreads (S→5, G→6, O→0, I→1, B→8, Z→2) are automatically fixed so codes like "A-S01" or "E-G01" resolve to the correct "A-501" / "E-601".',
    ],
  },
  {
    version: '1.0.8',
    date: 'May 13, 2026',
    changes: [
      'PDF upload: a single failing page no longer silently truncates the rest of the file — the renderer now retries the page (rebuilding the pdf.js worker if needed) and, if it still fails, marks just that page as failed and keeps going.',
      'PDF upload: at the end of an upload the app verifies that the page count it imported matches the page count of the source PDF, and shows a clear alert listing exactly which file and which pages were skipped so missing pages can no longer go unnoticed.',
    ],
  },
  {
    version: '1.0.7',
    date: 'May 12, 2026',
    changes: [
      'Page naming: the "Extract Number / Description" OCR now crops, upscales and contrast-enhances the selected region and constrains Tesseract to sheet-number characters on a single line, so codes like "A1.1" read correctly far more often instead of garbled near-misses.',
      'Page naming: the selection box border is now a thin hairline that stays crisp at any zoom, the corner grabbers have larger hit targets, and dragging a grabber resizes from that corner while the opposite corner stays anchored (it no longer drifts the whole box).',
      'Page naming: the preview now zooms with the mouse wheel toward the cursor and pans with a middle-mouse drag at any zoom level.',
    ],
  },
  {
    version: '1.0.6',
    date: 'May 5, 2026',
    changes: [
      'Time Tracking: monthly calendar heatmap above the entry list — each day shows total hours with shading by intensity, prev/next month navigation, and clicking a day filters the list to that date.',
      'Time Tracking: admins now see a "Team Time" tab that lists every user\'s entries, with a per-user totals summary, a user filter dropdown, and the same calendar heatmap aggregated across the team.',
      'Canvas: real-time collaboration sync now actually reaches other users on the same page — measurement add/update/delete and segment delete events were being broadcast to a room that nobody was joined to, so changes only appeared after a refresh.',
    ],
  },
  {
    version: '1.0.5',
    date: 'May 5, 2026',
    changes: [
      'Time Tracking: new standalone app in the navigation dock — clock in and out with a live running timer, add an optional description when clocking out, log manual entries (date, start/end time, description), and view entries grouped by day with daily and weekly totals. Anonymous sessions see a prompt to log in.',
      'Canvas: pressing Delete when a single segment is selected now removes only that segment instead of the entire measurement. Deleting the primary segment promotes the first additional segment to take its place; deleting the last remaining segment still removes the whole measurement.',
    ],
  },
  {
    version: '1.0.1',
    date: 'May 4, 2026',
    changes: [
      'Printouts: every segment of a multi-segment measurement is now rendered (and arcs are expanded), instead of only the first segment',
      'Canvas: dragging a vertex no longer drags the whole segment along with it — the parent group ignored its own children\'s drag-end events',
      'Canvas: double-clicking a segment line inserts a new vertex at the cursor, ordered between the surrounding pins; works on both primary and additional segments, and on touch via double-tap',
      'Collaboration: the user list now shows one entry per logged-in user even when they have multiple tabs open — the cursor and page come from whichever session is most recently active. Anonymous (not logged in) sessions are hidden from the list and from the canvas cursor layer',
    ],
  },
  {
    version: '1.0',
    date: 'May 4, 2026',
    changes: [
      'Measurements: renaming a measurement from the sidebar while viewing a different page no longer drags the highlight to the current page — the annotation stays put and only the name changes',
      'Drawing tools: length / area / count are now disabled when no measurement or takeoff is selected, and locked to match the type of the selected item so you cannot accidentally start a different kind of measurement; selecting a measurement automatically picks the right tool',
      'Drawing tools: the toolbar now follows the selected measurement\'s own type rather than its takeoff\'s, so a length measurement living inside an area takeoff correctly locks to the line tool',
      'Canvas: pressing Backspace while drawing now removes the last point instead of deleting the whole selected measurement; Delete still removes the selection as before',
      'Canvas: clicking a single segment on a multi-segment measurement now selects just that segment; clicking the measurement in the sidebar still selects the whole thing. Pressing P resumes the specific segment that\'s highlighted, and finalising rewrites that segment in place',
      'Canvas: selecting a segment by clicking it does not change the active tool — only sidebar selection switches the tool, since that signals an intent to draw',
      'Sidebar: a new chevron button at the top of the takeoff list collapses or expands every takeoff at once',
      'Sidebar: when a measurement is selected (from canvas or sidebar), its containing takeoff auto-expands and the row scrolls into view so you never lose track of where the selection lives',
    ],
  },
  {
    version: '0.9.9',
    date: 'April 29, 2026',
    changes: [
      'Measurements: drawing a new segment now correctly appends to the selected measurement instead of silently spawning a fresh one — the first click of the segment used to clear the selection before the canvas could read it',
      'Measurements: a new measurement is only created when nothing is selected; in that case it lands in the currently selected takeoff (or in Ungrouped if no takeoff is selected) so it can be assigned later',
      'Measurements: clicking a measurement in the sidebar now also activates the takeoff it belongs to, so the selected takeoff always matches the selected measurement and new segments inherit the right color and totals group',
    ],
  },
  {
    version: '0.9.7.9',
    date: 'April 23, 2026',
    changes: [
      'Printouts: full-screen progress overlay now appears whenever a PDF or Excel export is being generated, with live status messages so it is clear the app is working and what step it is on (e.g. "Rendering page 2 of 5…", "Adding scope details…", "Saving…")',
      'Proposals: the proposal generator reports each major stage — building cover, adding scope details, terms, rendering blueprint pages, and saving — instead of leaving the user with a greyed-out button',
      'Checklists: the checklist PDF generator reports per-item progress ("Drawing item 4 of 12…") during generation',
      'Shared printouts: fixed "Invalid data" error when opening a shared checklist PDF link — server data-URL parser now accepts the optional ;filename= parameter that jsPDF emits',
      'Shared printouts: PDF previews now use an HTML <object> with a fallback "Download" call-to-action for mobile browsers that can\'t render PDFs inline; the download filename is also normalised to end in .pdf',
      'Checklists: photos are now clickable everywhere they appear (the small thumbnails on the collapsed item row and the larger grid in the expanded view) — clicking opens a full-screen lightbox; click outside or press Esc to close',
      'Documentation: the README has been rewritten from scratch with a full feature overview, setup walkthrough, and placeholders for screenshots',
    ],
  },
  {
    version: '0.9.7.5',
    date: 'April 23, 2026',
    changes: [
      'PDF Editor: "Save As" now opens a native save dialog (File System Access API) on supported browsers so you can rename the file and choose a download location before saving — falls back to the previous direct download on browsers that do not support it',
      'PDF Editor: fixed the toolbar scrolling out of view on smaller desktop screens by switching to dynamic viewport height (100dvh), which also corrects layout on mobile browsers where the address bar reduces the available height',
      'PDF Editor: each page thumbnail in the sidebar now has a delete button (hover to reveal) — deleting a page removes it from the document, shifts all annotation positions, and updates the underlying PDF so the exported file matches what is displayed',
      'PDF Editor: "+" button in the sidebar header lets you import additional pages from a PDF file or from an image (JPEG, PNG, etc.) and append them to the current document',
      'PDF Editor: pages in the sidebar can be reordered by dragging the grip handle — works with both mouse and touch; dragging updates annotation page indices and the PDF page order so the exported file reflects the new layout',
    ],
  },
  {
    version: '0.9.8',
    date: 'April 23, 2026',
    changes: [
      'Proposals: "Include takeoff list" is now an optional checkbox on the proposal modal — when off, the takeoff summary page is omitted and the cost-detail option is disabled',
      'Proposals: the proposal modal now scrolls instead of overflowing on shorter desktop screens; header and footer stay visible',
      'Legend: default font size raised from 14 to 24px and width from 350 to 500px so the legend is legible out of the box on both the canvas and exported PDFs',
      'Legend: styled header bar, separator line, larger corner radius, and a more visible proportional resize handle in the bottom-right corner',
      'Legend: snap-to-corner preset buttons (top-left / top-right / bottom-left / bottom-right) and a text-size slider extended to 72px in the page settings panel',
      'Legend: "Apply legend settings to all pages" batch button copies font size, width, and totals toggle across every page in the project',
      'Legend: project-level "Enable on all pages by default" toggle — pages without an explicit legend setting inherit the project default in both the canvas view and exported PDFs',
      'Pages: selecting multiple pages and sharing now produces one combined link that opens a read-only vertical scroll gallery of all selected pages — no more one link per page',
      'Page naming: when adding pages whose sheet number matches an existing page, the new page is flagged as a "REVISION" with an amber badge and helper text in the naming step',
      'Page naming: sheet number and description are auto-detected from PDF page labels, the filename, or repeated tokens in the extracted text — no more manual entry for cleanly labelled drawings',
      'Page naming: the region-selection preview in the New Project flow now uses the full-resolution image instead of the small thumbnail',
      'Checklists: drag-handle on each item lets you reorder items by drag-and-drop, including across the Pending / Completed divider',
      'Checklists: new "In Progress" photo section between Before and After, including in the printed PDF',
      'Checklists: per-item Comments field for notes, blockers, or reasons an item can\'t be completed yet — printed as a NOTES block on the PDF',
      'Security: app now trusts the first reverse-proxy hop (e.g. Cloudflare) so login rate-limiting buckets per real client IP from X-Forwarded-For instead of all traffic under the proxy address',
    ],
  },
  {
    version: '0.9.7',
    date: 'April 22, 2026',
    changes: [
      'Bid Pipeline: full email integration — bid invitations received by email are automatically imported into the pipeline via IMAP monitoring, or pasted in manually',
      'Bid Pipeline: send proposals as email replies directly from the pipeline using SMTP, with proper reply-threading headers so the response lands in the original conversation',
      'Bid Pipeline: emails in the same conversation are grouped into a single pipeline entry by subject (Re:/Fwd: prefixes stripped for matching); new replies on an existing thread are appended automatically on the next poll',
      'Bid Pipeline: threaded view — click "Show thread (N)" to expand the full conversation newest-first; latest message is auto-expanded, older messages are individually collapsible',
      'Bid Pipeline: HTML emails render with full formatting in a sandboxed iframe instead of plain text',
      'Settings → Email: new tab for configuring outbound SMTP and inbound IMAP accounts (multiple accounts supported)',
      'Settings → Email: provider preset dropdown in the IMAP account form auto-fills server settings for Gmail, Outlook, Yahoo, and iCloud',
      'Settings → Email: Email Provider Setup Guide with step-by-step instructions, direct links to app-password pages, and server settings for Gmail, Outlook, Yahoo, and Apple iCloud',
      'Settings → Email: configurable automatic polling interval (5 min – 1 hr) with a manual Poll Now button',
      'Auth: JWT signing secret is now auto-generated on first boot and persisted in the database — no environment variable setup required for new installs',
      'Security: the public /api/settings endpoint no longer leaks smtp.* or jwt.* keys to unauthenticated callers',
    ],
  },
  {
    version: '0.9.6',
    date: 'April 21, 2026',
    changes: [
      'Estimating: measurements can now have multiple segments — after closing an area or finalising a line, the next click continues adding segments within the same measurement; a "New Measurement" button in the sidebar starts a fresh measurement',
      'Estimating: Ctrl+click (desktop) or the new multi-select toolbar button (mobile) selects multiple measurements of the same type; a Merge button folds all selected areas or lines into a single multi-segment measurement',
      'Estimating: Excel export now matches the Takeoffs tab layout — columns are Name, Type, Qty (formatted), Unit Cost, and Total Cost',
      'Estimating: Excel export includes advanced-pricing detail rows showing item quantities and units (e.g. "5.25 bags of Concrete Mix at $14.00/unit = $73.50") for each custom cost item',
      'Estimating: Excel export groups takeoffs under price-package headers, matching the on-screen grouping',
    ],
  },
  {
    version: '0.9.5.5',
    date: 'April 21, 2026',
    changes: [
      'Mobile: the app navigation sidebar is now hidden when viewing a canvas page on a phone or tablet, giving the full screen to the drawing area',
      'Mobile: the canvas now fills the complete viewport width (previously shifted right by 64px due to the collapsed sidebar)',
      'Mobile: tool toolbar repositioned below the page header on small screens so it is no longer hidden behind it',
      'Mobile: one-finger touch now exclusively draws, selects, or places points — it never pans the canvas',
      'Mobile: two-finger gesture simultaneously pans and pinch-zooms the canvas (drag both fingers to pan, spread/pinch to zoom, or both at once)',
      'Mobile: zoom buttons repositioned higher from the bottom edge so they are not hidden behind iOS/Android browser chrome',
      'Mobile: fixed stuttering during two-finger pan and zoom — Konva stage is now updated imperatively each frame with React state synced via requestAnimationFrame',
    ],
  },
  {
    version: '0.9.5',
    date: 'April 21, 2026',
    changes: [
      'Estimating: middle mouse button now exclusively pans the canvas and can no longer accidentally grab or move a measurement',
      'Estimating: Ctrl-Z undo now covers moving, dragging, and renaming measurements (in addition to adding/deleting)',
      'Estimating: linear area wall heights now default to a single global height; per-point heights are opt-in via a checkbox',
      'Estimating: right-click anywhere on the canvas shows a context menu with Undo, Redo, Copy, Paste, Delete (when over a measurement), and Cancel Drawing (when drawing)',
      'Estimating: double-click on an existing measurement line inserts a new point at that location',
      'Estimating: arcs (A key) now store only 3 points — start, middle, and end — and render as a smooth curve; the 3 handles are draggable to reshape the arc',
      'Projects: clicking the checkbox on a page thumbnail multi-selects pages; a "Share (N)" button copies all share links at once',
      'Projects: scroll position in the pages tab is remembered and restored when returning to the list',
    ],
  },
  {
    version: '0.9.4.1',
    date: 'April 20, 2026',
    changes: [
      'Checklists: data (lists, items, photos) is now stored on the server — checklists are visible across all devices when logged in with the same account',
      'Checklists: one-time automatic migration uploads any locally-stored checklist data and photos from the previous version to the server on first load',
    ],
  },
  {
    version: '0.9.4',
    date: 'April 20, 2026',
    changes: [
      'Checklists: support multiple Before and After photos per item — upload via file picker, drag-and-drop onto the photo zone, or capture from camera; each photo stored independently with per-photo remove button',
      'Checklists: photos are now EXIF-orientation-corrected on upload — phone photos no longer appear rotated in the UI or in generated PDFs',
      'Checklists: PDF export renders all before/after photos in rows (up to 4 per row) per item, with box height calculated dynamically',
      'Checklists: printouts are saved to the server and open in the PDF Editor (same flow as Estimate printouts) instead of about:blank',
      'Checklists: share links — each printout card now has a Share button that generates a /share/<id> URL and copies it to the clipboard',
      'Checklists: mobile-friendly layout — top bar collapses on small screens, list sidebar becomes a slide-over drawer, and photo grid stacks to a single column',
      'Estimating: active measurement tool now makes existing drawn measurements non-interactive (click-through), preventing accidental selection while drawing',
      'Estimating: bid due date removed from proposal PDF cover page',
      'Estimating: total cost values on the Takeoffs tab and in generated PDFs are now rounded up to the nearest $100',
      'Spreadsheet Editor: replaced jspreadsheet-ce with FortuneSheet for a more capable, reliable in-browser spreadsheet experience',
      'Docker: hardened build for native module compilation; added GHA layer caching for faster CI builds',
    ],
  },
  {
    version: '0.9.3',
    date: 'April 15, 2026',
    changes: [
      'Spreadsheet Editor: Excel printouts now open in a full in-browser spreadsheet editor (jspreadsheet) instead of triggering a download — supports editing, multiple sheets, and saving changes back to the Printout or downloading a local copy',
      'Spreadsheet Editor: state persists across navigation and browser restarts via IndexedDB, with multi-tab support for working on several files simultaneously',
      'PDF Editor: rendering quality improved (scale 2×, JPEG quality 0.92) and state now persists across navigation via IndexedDB',
      'Sharing: share links for printouts and project pages — generate a public URL from the Printouts tab or any project page; configure the public host URL under Settings → General → Sharing',
      'Settings: added Sharing card to General Settings tab for configuring the public host URL used in share links',
    ],
  },
  {
    version: '0.9.2.4',
    date: 'April 14, 2026',
    changes: [
      'PDF Editor: split "Save PDF" into two buttons — Save overwrites the original Printout on the server (or downloads locally if opened from a file), Save As always downloads a local annotated copy',
    ],
  },
  {
    version: '0.9.2.3',
    date: 'April 13, 2026',
    changes: [
      'Printouts tab: clicking the View button on a PDF now opens it directly in the PDF Editor instead of a new browser tab',
    ],
  },
  {
    version: '0.9.2.2',
    date: 'April 13, 2026',
    changes: [
      'PDF Editor: fixed exported annotations appearing upside-down — pdf-lib already handles PDF y-up coordinates for embedded images, so the manual vertical flip was double-flipping the overlay',
    ],
  },
  {
    version: '0.9.2.1',
    date: 'April 13, 2026',
    changes: [
      'PDF Editor: text box now reliably appears when clicking — fixed focus being stolen by the Konva canvas on mousedown',
      'PDF Editor: PDF export annotations are no longer upside-down — canvas overlay is now counter-rotated and vertically flipped to match pdf-lib\'s y-up coordinate system before embedding',
    ],
  },
  {
    version: '0.9.2',
    date: 'April 11, 2026',
    changes: [
      'PDF Editor: text annotations are now edited in-place with a floating textarea overlay — no more browser prompt popup',
      'PDF Editor: fixed annotation coordinate offset at non-100% zoom levels — shapes now draw exactly where the cursor lands',
      'PDF Editor: zoom preset menu now opens downward instead of off-screen above the toolbar',
      'PDF Editor: signature and image aspect ratios are preserved when placed — signatures no longer appear squished',
      'PDF Editor: white-background removal for signatures uses a softer gradient threshold (170–220), cleanly removing scanner backgrounds without erasing light ink',
      'PDF Editor: images and signatures are automatically selected after insertion, showing the resize Transformer immediately',
      'PDF Editor: Delete key now removes selected images and signatures in addition to other annotation types',
      'PDF Editor: PDF export now correctly positions annotations on rotated pages (scanned landscape PDFs) using a canvas overlay with rotation-aware pdf-lib placement',
    ],
  },
  {
    version: '0.9.1',
    date: 'April 11, 2026',
    changes: [
      'PDF Editor: multi-file tabs — opening a second PDF creates a new tab above the toolbar; switching tabs preserves each file\'s annotation and undo history independently',
      'PDF Editor: page thumbnail sidebar with per-page thumbnails; clicking scrolls to the page in scroll mode or switches to it in single-page mode; toggleable via toolbar button',
      'PDF Editor: zoom controls — zoom in/out buttons, preset levels (50%–200%), Fit Width, Fit Height, Fit Page; Ctrl+wheel and Ctrl+=/- keyboard shortcuts',
      'PDF Editor: single-page view mode toggle with Previous/Next navigation bar',
    ],
  },
  {
    version: '0.9.0',
    date: 'April 11, 2026',
    changes: [
      'PDF Editor sub-application: open local PDFs, annotate with freehand pen, lines, arrows, rectangles, ellipses, text, and images, then export back to PDF',
      'Signature tool: save reusable signatures from image files with automatic white-background removal, place and resize on any page',
      'Full undo/redo history and keyboard shortcuts in the PDF Editor',
      'Side dock navigation: collapsible/hideable left sidebar with per-app navigation, persistent across sessions',
      'Merged Settings page: user preferences and server settings combined under one route with admin-only tab gating',
      'Advanced costing: Unit label field added to Material Yield and Rate per Units cost types in all takeoff editors',
      'Fixed username display in the active users overlay — eliminated intermittent "User" placeholder caused by async state race',
      'Version changelog added to Settings',
    ],
  },
  {
    version: '0.8.0',
    date: 'April 7–8, 2026',
    changes: [
      'Proposal PDF enhancements: header color picker, custom fonts, cover page notes, valid-until date, terms & conditions page, signature block, and page numbers',
      'Highlight print quality selector with preset options for proposal and standalone printing',
      'Server-side user preference sync for cross-browser persistence',
      'Collaboration user list improvements: numbered duplicate instances and readable page location names',
    ],
  },
  {
    version: '0.7.0',
    date: 'April 5–6, 2026',
    changes: [
      'Price package field on takeoffs with automatic grouping in sidebar',
      'Custom autocomplete dropdown for price package selection',
      'Shared NewTakeoffModal component extracted for reuse',
      'Proposal PDF takeoff list grouped by price package',
      'Append highlighted blueprint pages to proposal PDF using pdf-lib merge',
    ],
  },
  {
    version: '0.6.0',
    date: 'April 4, 2026',
    changes: [
      'Proposal PDF generator with branded cover page and takeoff summary',
      'Accent color system replacing all hardcoded blues throughout the app',
    ],
  },
  {
    version: '0.5.0',
    date: 'April 3, 2026',
    changes: [
      'Glass UI design with dark mode support',
      'Accent color picker in user settings',
      'Dark mode applied across all pages and components',
      'Toast notifications for user feedback',
      'Undo/redo support for measurements',
      'Keyboard shortcuts for common actions',
    ],
  },
  {
    version: '0.4.0',
    date: 'April 2, 2026',
    changes: [
      'Security hardening: rate limiting, input validation, and query optimization',
      'Fixed authentication header handling across all views',
      'Performance improvements for large project lists',
    ],
  },
  {
    version: '0.3.0',
    date: 'March 29–31, 2026',
    changes: [
      'Project notes with rich text support',
      'Server settings page for application branding and contractor info',
      'Search with persistence and term highlighting',
      'Global user presence and real-time collaboration controls',
    ],
  },
  {
    version: '0.2.0',
    date: 'March 24–28, 2026',
    changes: [
      'Legend display and customization on canvas pages',
      'Copy/paste functionality for measurements',
      'Ability to resume incomplete measurements',
    ],
  },
  {
    version: '0.1.0',
    date: 'March 11–21, 2026',
    changes: [
      'Initial project structure with React, TypeScript, and Tailwind CSS',
      'Express.js backend with SQLite database',
      'JWT authentication and user management',
      'PDF blueprint upload, rendering, and page navigation',
      'Canvas-based measurement tools (linear, area, count)',
      'Takeoff cost management and bid tracking',
      'Real-time collaboration via Socket.IO',
      'Thumbnail generation and plan set versioning',
      'Docker deployment configuration',
    ],
  },
];

// ── User Preferences tab ─────────────────────────────────────────────────────

const ACCENT_PRESETS: { key: AccentKey; label: string; hue: number }[] = [
  { key: 'blue',    label: 'Blue',    hue: 264 },
  { key: 'indigo',  label: 'Indigo',  hue: 283 },
  { key: 'violet',  label: 'Violet',  hue: 303 },
  { key: 'emerald', label: 'Emerald', hue: 162 },
  { key: 'rose',    label: 'Rose',    hue: 15  },
  { key: 'amber',   label: 'Amber',   hue: 84  },
];

function accentSwatchColor(hue: number) {
  return `oklch(0.52 0.24 ${hue})`;
}

const PreferencesTab: React.FC = () => {
  const { mode, accentColor, customAccentHex, reducedMotion, toggleMode, setAccentColor, setCustomAccent, setReducedMotion } = useTheme();
  const { toast } = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [autoName, setAutoName] = useState<boolean>(aiAutoNameEnabled());
  const [aiIdleMinutes, setAiIdleMinutes] = useState<string>('5');
  const [aiSettings, setAiSettings] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const s = await getAiStatus(true);
      if (cancelled) return;
      setAiStatus(s);
      // While the model is downloading/loading, keep polling so the page flips
      // to "ready" on its own without a manual refresh.
      if (s.state === 'loading') timer = setTimeout(tick, 5000);
    };
    tick();
    // Load the idle-timeout setting
    getSettings().then(s => {
      if (cancelled) return;
      setAiSettings(s);
      if (s['aiIdleTimeoutMinutes'] !== undefined) setAiIdleMinutes(s['aiIdleTimeoutMinutes']);
    }).catch(() => {});
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const handleAiIdleBlur = async () => {
    const val = aiIdleMinutes.trim();
    const num = parseFloat(val);
    const safe = isNaN(num) || num < 0 ? '5' : String(num);
    setAiIdleMinutes(safe);
    try {
      await saveSettings({ ...(aiSettings ?? {}), aiIdleTimeoutMinutes: safe });
      setAiSettings(prev => ({ ...(prev ?? {}), aiIdleTimeoutMinutes: safe }));
    } catch (err: any) {
      toast(err?.message?.includes('admin') || err?.message?.includes('403') ? 'Only admins can change this.' : (err?.message ?? 'Failed to save.'), { type: 'error' });
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      toast('New password must be at least 6 characters', { type: 'error' });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast('New passwords do not match', { type: 'error' });
      return;
    }
    setSavingPassword(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to change password');
      toast('Password changed', { type: 'success' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      toast(err.message, { type: 'error' });
    } finally {
      setSavingPassword(false);
    }
  };

  const pwInputCls = 'w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none';

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Appearance</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Control how the application looks and feels.</p>
        </div>
        <div className="p-6 space-y-6">
          {/* Dark Mode */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-accent-600 dark:text-accent-400 shrink-0">
                <AnimatePresence mode="wait" initial={false}>
                  {mode === 'dark' ? (
                    <motion.div key="moon"
                      initial={{ opacity: 0, rotate: -30, scale: 0.7 }} animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: 30, scale: 0.7 }} transition={{ duration: 0.18 }}>
                      <Moon size={18} />
                    </motion.div>
                  ) : (
                    <motion.div key="sun"
                      initial={{ opacity: 0, rotate: 30, scale: 0.7 }} animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: -30, scale: 0.7 }} transition={{ duration: 0.18 }}>
                      <Sun size={18} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Dark Mode</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Switch between light and dark interface</p>
              </div>
            </div>
            <button
              role="switch" aria-checked={mode === 'dark'} onClick={toggleMode}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${mode === 'dark' ? 'bg-accent-600' : 'bg-slate-200 dark:bg-slate-700'}`}
            >
              <motion.div layout transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${mode === 'dark' ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>

          {/* Reduce Motion */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-accent-600 dark:text-accent-400 shrink-0">
                {reducedMotion ? <ZapOff size={16} /> : <Zap size={16} />}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Reduce Motion</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Minimize animations for accessibility or performance</p>
              </div>
            </div>
            <button
              role="switch" aria-checked={reducedMotion} onClick={() => setReducedMotion(!reducedMotion)}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${reducedMotion ? 'bg-accent-600' : 'bg-slate-200 dark:bg-slate-700'}`}
            >
              <motion.div layout transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${reducedMotion ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Accent Colour</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Applied to buttons, active states, and interactive elements.</p>
        </div>
        <div className="p-6">
          <div className="flex items-center gap-3 flex-wrap">
            {ACCENT_PRESETS.map(preset => (
              <button
                key={preset.key}
                onClick={() => setAccentColor(preset.key)}
                title={preset.label}
                aria-label={preset.label}
                aria-pressed={accentColor === preset.key}
                className="relative w-9 h-9 rounded-full transition-transform hover:scale-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
                style={{ background: accentSwatchColor(preset.hue) } as React.CSSProperties}
              >
                <AnimatePresence>
                  {accentColor === preset.key && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }} transition={{ duration: 0.15 }}
                      className="absolute inset-0 flex items-center justify-center rounded-full ring-2 ring-white ring-offset-2"
                    >
                      <Check size={14} className="text-white drop-shadow" strokeWidth={3} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </button>
            ))}

            {/* Custom colour — native colour picker behind a swatch */}
            <label
              title="Custom colour"
              aria-label="Custom accent colour"
              className="relative w-9 h-9 rounded-full cursor-pointer transition-transform hover:scale-110 active:scale-95 focus-within:ring-2 focus-within:ring-offset-2 dark:focus-within:ring-offset-slate-800"
              style={{ background: customAccentHex } as React.CSSProperties}
            >
              <input
                type="color"
                value={customAccentHex}
                aria-label="Pick a custom accent colour"
                onChange={(e) => setCustomAccent(e.target.value)}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <AnimatePresence>
                {accentColor === 'custom' && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }} transition={{ duration: 0.15 }}
                    className="absolute inset-0 flex items-center justify-center rounded-full ring-2 ring-white ring-offset-2 pointer-events-none"
                  >
                    <Check size={14} className="text-white drop-shadow" strokeWidth={3} />
                  </motion.div>
                )}
              </AnimatePresence>
            </label>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-4">
            Current:{' '}
            <span className="font-medium text-slate-700 dark:text-slate-300 capitalize">
              {accentColor === 'custom' ? customAccentHex : accentColor}
            </span>
          </p>
        </div>
      </div>

      {/* AI Sheet Reading */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Sparkles size={18} /> AI Sheet Reading
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {aiStatus?.state === 'ready'
              ? `Local model ready: ${aiStatus.model} (${aiStatus.device}).`
              : aiStatus?.state === 'loading'
              ? 'Model is starting up — on first run it downloads the weights (this can take several minutes). Watch the container log for download progress. This will update automatically.'
              : aiStatus?.state === 'idle'
              ? `Local model idle: ${aiStatus.model} (${aiStatus.device}).`
              : 'No local model detected. Page naming falls back to text/OCR extraction. See the ops runbook to enable it.'}
          </p>
        </div>
        <div className="p-6 space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-900 dark:text-white">Enable AI sheet reading</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Renders page images for AI and shows the AI Scan button on the naming screen. Nothing runs until you click AI Scan.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoName}
              disabled={!aiStatus?.available}
              onClick={() => { const next = !autoName; setAutoName(next); setAiAutoNameEnabled(next); }}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 disabled:opacity-50 disabled:cursor-not-allowed ${autoName && aiStatus?.available ? 'bg-accent-600' : 'bg-slate-200 dark:bg-slate-700'}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-all ${autoName && aiStatus?.available ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-900 dark:text-white">Unload model after (minutes idle)</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Frees GPU memory when idle. 0 = keep loaded.
              </p>
            </div>
            <input
              type="number"
              min="0"
              step="1"
              value={aiIdleMinutes}
              onChange={e => setAiIdleMinutes(e.target.value)}
              onBlur={handleAiIdleBlur}
              disabled={!aiStatus?.available}
              className="w-24 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white text-sm focus:ring-2 focus:ring-accent-500 outline-none disabled:opacity-50"
            />
          </div>
        </div>
      </div>

      {/* Change Password */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Lock size={18} className="text-accent-600 dark:text-accent-400" />
            Change Password
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Update the password you use to sign in.</p>
        </div>
        <form onSubmit={handleChangePassword} className="p-6 space-y-4 max-w-md">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Current password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              className={pwInputCls}
              placeholder="Enter current password"
              autoComplete="current-password"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">New password</label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className={pwInputCls}
              placeholder="At least 6 characters"
              autoComplete="new-password"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Confirm new password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className={pwInputCls}
              placeholder="Re-enter new password"
              autoComplete="new-password"
              required
            />
          </div>
          <button
            type="submit"
            disabled={savingPassword || !currentPassword || !newPassword || !confirmPassword}
            className="flex items-center justify-center gap-2 bg-accent-600 hover:bg-accent-700 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {savingPassword ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            Change Password
          </button>
        </form>
      </div>
    </div>
  );
};

// ── Shared form chrome ────────────────────────────────────────

const inputCls = 'w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none transition-all';
const labelCls = 'block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider';

// ── Changelog tab ─────────────────────────────────────────────────────────────

const ChangelogTab: React.FC = () => (
  <div className="space-y-6">
    {CHANGELOG.map((entry, i) => (
      <div key={entry.version} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex items-center gap-3">
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300">
            v{entry.version}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400">{entry.date}</span>
          {i === 0 && (
            <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
              Latest
            </span>
          )}
        </div>
        <div className="p-6">
          <ul className="space-y-2">
            {entry.changes.map((change, j) => (
              <li key={j} className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-300">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent-500 shrink-0" />
                {change}
              </li>
            ))}
          </ul>
        </div>
      </div>
    ))}
  </div>
);

const StorageTab: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [orphans, setOrphans] = useState<{ count: number; bytes: number } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, o] = await Promise.all([getStorageStats(), getStorageOrphans().catch(() => null)]);
      setStats(s);
      setOrphans(o);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load storage usage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCleanup = async () => {
    if (!orphans || orphans.count === 0) return;
    const ok = await confirm({
      title: 'Reclaim space',
      message: `Permanently delete ${orphans.count} unreferenced file${orphans.count === 1 ? '' : 's'} (${formatBytes(orphans.bytes)})? This cannot be undone.`,
      confirmLabel: 'Delete files',
      tone: 'danger',
    });
    if (!ok) return;
    setCleaning(true);
    try {
      const { deleted, bytesFreed } = await cleanupStorageOrphans();
      toast(`Reclaimed ${formatBytes(bytesFreed)} from ${deleted} file${deleted === 1 ? '' : 's'}`, { type: 'success' });
      await load();
    } catch {
      toast('Failed to reclaim space', { type: 'error' });
    } finally {
      setCleaning(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600" />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm p-6">
        <p className="text-sm text-red-500">{error || 'No data available.'}</p>
        <button onClick={load} className="mt-4 px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all flex items-center gap-2">
          <RefreshCw size={16} /> Retry
        </button>
      </div>
    );
  }

  const categories = [
    { key: 'images', label: 'Files & Images', color: 'bg-accent-500' },
    { key: 'projects', label: 'Projects', color: 'bg-blue-500' },
    { key: 'notes', label: 'Notes', color: 'bg-amber-500' },
    { key: 'templates', label: 'Templates', color: 'bg-purple-500' },
    { key: 'checklists', label: 'Checklists', color: 'bg-pink-500' },
  ] as const;
  const breakdownTotal = Object.values(stats.breakdown).reduce((a, b) => a + b, 0) || 1;
  const maxProject = stats.projects[0]?.totalBytes || 1;

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HardDrive className="text-accent-600" size={22} />
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">Storage Usage</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">How much disk space the application's data occupies.</p>
            </div>
          </div>
          <button onClick={load} title="Refresh" className="p-2 rounded-lg text-slate-400 hover:text-accent-600 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all">
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-xl bg-slate-50 dark:bg-slate-900/50 p-4">
            <div className="text-2xl font-bold text-slate-900 dark:text-white">{formatBytes(stats.databaseBytes)}</div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-1">Database on disk</div>
          </div>
          <div className="rounded-xl bg-slate-50 dark:bg-slate-900/50 p-4">
            <div className="text-2xl font-bold text-slate-900 dark:text-white">{stats.projectCount.toLocaleString()}</div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-1">Projects</div>
          </div>
          <div className="rounded-xl bg-slate-50 dark:bg-slate-900/50 p-4">
            <div className="text-2xl font-bold text-slate-900 dark:text-white">{stats.imageCount.toLocaleString()}</div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-1">Stored files</div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Breakdown by Type</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Content size stored in each part of the database.</p>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
            {categories.map(c => {
              const bytes = stats.breakdown[c.key];
              if (!bytes) return null;
              return <div key={c.key} className={c.color} style={{ width: `${(bytes / breakdownTotal) * 100}%` }} title={`${c.label}: ${formatBytes(bytes)}`} />;
            })}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {categories.map(c => (
              <div key={c.key} className="flex items-center gap-3 text-sm">
                <span className={`w-2.5 h-2.5 rounded-full ${c.color} shrink-0`} />
                <span className="text-slate-600 dark:text-slate-300">{c.label}</span>
                <span className="ml-auto font-medium text-slate-900 dark:text-white">{formatBytes(stats.breakdown[c.key])}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {orphans && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-100 dark:border-slate-700">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Sparkles size={18} className="text-accent-600" /> Reclaim Space
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">Unreferenced files left behind by failed uploads or deleted pages and plan-set revisions.</p>
          </div>
          <div className="p-6 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-1">
              {orphans.count === 0 ? (
                <p className="text-sm text-slate-600 dark:text-slate-300">No orphaned files — storage is clean.</p>
              ) : (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  <span className="font-bold text-slate-900 dark:text-white">{orphans.count.toLocaleString()}</span> orphaned file{orphans.count === 1 ? '' : 's'} taking up <span className="font-bold text-slate-900 dark:text-white">{formatBytes(orphans.bytes)}</span>.
                </p>
              )}
            </div>
            <button
              onClick={handleCleanup}
              disabled={orphans.count === 0 || cleaning}
              className="shrink-0 px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50 flex items-center gap-2"
            >
              {cleaning ? <RefreshCw size={16} className="animate-spin" /> : <Trash2 size={16} />}
              {cleaning ? 'Reclaiming…' : 'Reclaim space'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Usage by Project</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Projects ranked by total space used, including their files.</p>
        </div>
        <div className="p-6">
          {stats.projects.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No projects yet.</p>
          ) : (
            <div className="space-y-3">
              {stats.projects.map(p => (
                <div key={p.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="truncate text-slate-700 dark:text-slate-300">{p.name}</span>
                    <span className="font-medium text-slate-900 dark:text-white whitespace-nowrap">{formatBytes(p.totalBytes)}</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
                    <div className="h-full rounded-full bg-accent-500" style={{ width: `${(p.totalBytes / maxProject) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ── AIA Export Template tab ────────────────────────────────────────────────────

// Default mapping — sensible starting point the admin edits rather than a blank
// form. Mirrors AiaTemplateMapping in aiaExcel.ts (kept structural to avoid a
// runtime dependency on the lazy-loaded exceljs module).
interface AiaMapping {
  g702Sheet: string;
  cells: Record<string, string>;
  g703Sheet: string;
  g703StartRow: number;
  g703Cols: Record<string, string>;
  moneyAsDollars: boolean;
}

const G702_CELL_FIELDS: { key: string; label: string }[] = [
  { key: 'ownerName', label: 'Owner name' },
  { key: 'ownerAddress', label: 'Owner address' },
  { key: 'projectName', label: 'Project name' },
  { key: 'contractorName', label: 'Contractor name' },
  { key: 'architectName', label: 'Architect name' },
  { key: 'contractFor', label: 'Contract for' },
  { key: 'applicationNo', label: 'Application no.' },
  { key: 'periodTo', label: 'Period to' },
  { key: 'applicationDate', label: 'Application date' },
  { key: 'contractDate', label: 'Contract date' },
  { key: 'ownerProjectNumber', label: 'Owner project no.' },
  { key: 'architectProjectNumber', label: 'Architect project no.' },
  { key: 'retainageWorkPct', label: 'Retainage % (work)' },
  { key: 'retainageStoredPct', label: 'Retainage % (stored)' },
  { key: 'L1', label: 'Line 1 — Original contract sum' },
  { key: 'L2', label: 'Line 2 — Net change orders' },
  { key: 'L3', label: 'Line 3 — Contract sum to date' },
  { key: 'L4', label: 'Line 4 — Total completed & stored' },
  { key: 'L5a', label: 'Line 5a — Retainage (work)' },
  { key: 'L5b', label: 'Line 5b — Retainage (stored)' },
  { key: 'L5', label: 'Line 5 — Total retainage' },
  { key: 'L6', label: 'Line 6 — Earned less retainage' },
  { key: 'L7', label: 'Line 7 — Less previous certificates' },
  { key: 'L8', label: 'Line 8 — Current payment due' },
  { key: 'L9', label: 'Line 9 — Balance to finish' },
  { key: 'coAdditions', label: 'CO additions' },
  { key: 'coDeductions', label: 'CO deductions' },
  { key: 'coNet', label: 'CO net change' },
];

const G703_COL_FIELDS: { key: string; label: string }[] = [
  { key: 'itemNo', label: 'Item no.' },
  { key: 'description', label: 'Description' },
  { key: 'scheduledValue', label: 'Scheduled value (C)' },
  { key: 'previous', label: 'Previous (D)' },
  { key: 'thisPeriod', label: 'This period (E)' },
  { key: 'stored', label: 'Stored (F)' },
  { key: 'total', label: 'Total to date (G)' },
  { key: 'percent', label: '% (G/C)' },
  { key: 'balance', label: 'Balance (I)' },
  { key: 'retainage', label: 'Retainage (J)' },
];

const DEFAULT_AIA_MAPPING: AiaMapping = {
  g702Sheet: 'G702',
  cells: {},
  g703Sheet: 'G703',
  g703StartRow: 2,
  g703Cols: {
    itemNo: 'A', description: 'B', scheduledValue: 'C', previous: 'D',
    thisPeriod: 'E', stored: 'F', total: 'G', percent: 'H', balance: 'I', retainage: 'J',
  },
  moneyAsDollars: true,
};

const AiaTemplateTab: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [templateFileId, setTemplateFileId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [mapping, setMapping] = useState<AiaMapping>(DEFAULT_AIA_MAPPING);

  useEffect(() => {
    (async () => {
      try {
        const s = await getSettings();
        if (s.aiaTemplateFileId) setTemplateFileId(s.aiaTemplateFileId);
        if (s.aiaTemplateName) setTemplateName(s.aiaTemplateName);
        if (s.aiaTemplateMapping) {
          try {
            const parsed = JSON.parse(s.aiaTemplateMapping);
            setMapping({ ...DEFAULT_AIA_MAPPING, ...parsed,
              cells: { ...parsed.cells }, g703Cols: { ...DEFAULT_AIA_MAPPING.g703Cols, ...parsed.g703Cols } });
          } catch { /* keep defaults on parse error */ }
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, []);

  const setCell = (key: string, val: string) =>
    setMapping(m => ({ ...m, cells: { ...m.cells, [key]: val } }));
  const setCol = (key: string, val: string) =>
    setMapping(m => ({ ...m, g703Cols: { ...m.g703Cols, [key]: val } }));

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-uploading the same filename
    if (!file) return;
    try {
      // settings-asset keeps the template out of the Documents page; it belongs to
      // no project or entity, so it carries no projectId/source. The read path
      // (getFile → dataUrl) is unchanged — the server still reconstructs a dataURL.
      const { fileId } = await saveBinaryFile(uuidv4(), file, {
        kind: 'settings-asset', name: file.name,
      });
      await saveSettings({ aiaTemplateFileId: fileId, aiaTemplateName: file.name });
      setTemplateFileId(fileId);
      setTemplateName(file.name);
      toast('Template uploaded', { type: 'success' });
    } catch {
      toast('Failed to upload template', { type: 'error' });
    }
  };

  const handleRemove = async () => {
    const ok = await confirm({
      title: 'Remove template',
      message: 'Remove the configured AIA template? Exports will revert to the standard generated G702/G703.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await saveSettings({ aiaTemplateFileId: '', aiaTemplateName: '' });
      setTemplateFileId('');
      setTemplateName('');
      toast('Template removed', { type: 'success' });
    } catch {
      toast('Failed to remove template', { type: 'error' });
    }
  };

  const handleSaveMapping = async () => {
    setSaving(true);
    try {
      await saveSettings({ aiaTemplateMapping: JSON.stringify(mapping) });
      toast('Mapping saved', { type: 'success' });
    } catch {
      toast('Failed to save mapping', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600" /></div>;

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <FileSpreadsheet size={20} className="text-accent-600" /> AIA Export Template
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Upload your AIA G702/G703 .xlsx and map each value to the cell it should fill. Leave a cell blank to skip it. When no template is set, the app generates a standard G702/G703.
          </p>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-4 flex-wrap">
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handleUpload} className="hidden" id="aia-template-upload" />
            <label htmlFor="aia-template-upload"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-600 cursor-pointer transition-all shadow-sm">
              <FileSpreadsheet size={16} /> {templateFileId ? 'Replace Template' : 'Upload .xlsx Template'}
            </label>
            {templateFileId ? (
              <>
                <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1.5">
                  <CheckCircle size={15} /> {templateName || 'Template configured'}
                </span>
                <button onClick={handleRemove} className="text-sm text-red-500 hover:text-red-600 font-medium flex items-center gap-1">
                  <Trash2 size={14} /> Remove
                </button>
              </>
            ) : (
              <span className="text-sm text-slate-500 dark:text-slate-400">No template configured — using the standard generated export.</span>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h3 className="text-base font-bold text-slate-900 dark:text-white">G702 — Sheet & Cell Mapping</h3>
        </div>
        <div className="p-6 space-y-4">
          <div className="max-w-xs">
            <label className={labelCls}>G702 sheet name</label>
            <input className={inputCls} value={mapping.g702Sheet} onChange={e => setMapping(m => ({ ...m, g702Sheet: e.target.value }))} placeholder="G702 or 1" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {G702_CELL_FIELDS.map(f => (
              <div key={f.key}>
                <label className={labelCls}>{f.label}</label>
                <input className={inputCls} value={mapping.cells[f.key] || ''} onChange={e => setCell(f.key, e.target.value)} placeholder="e.g. F20" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h3 className="text-base font-bold text-slate-900 dark:text-white">G703 — Continuation Sheet Mapping</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Each schedule-of-values line writes into a row, starting at the start row. Provide the column letter for each value.</p>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
            <div>
              <label className={labelCls}>G703 sheet name</label>
              <input className={inputCls} value={mapping.g703Sheet} onChange={e => setMapping(m => ({ ...m, g703Sheet: e.target.value }))} placeholder="G703 or 1" />
            </div>
            <div>
              <label className={labelCls}>First data row</label>
              <input className={inputCls} type="number" min={1} value={mapping.g703StartRow}
                onChange={e => setMapping(m => ({ ...m, g703StartRow: parseInt(e.target.value) || 1 }))} placeholder="2" />
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {G703_COL_FIELDS.map(f => (
              <div key={f.key}>
                <label className={labelCls}>{f.label}</label>
                <input className={inputCls} value={mapping.g703Cols[f.key] || ''} onChange={e => setCol(f.key, e.target.value)} placeholder="e.g. C" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={handleSaveMapping} disabled={saving}
          className="px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50 flex items-center gap-2">
          <Save size={16} /> {saving ? 'Saving…' : 'Save Mapping'}
        </button>
      </div>
    </div>
  );
};

// Admin "Document types" card (spec §Decisions "Custom types"): custom kinds
// available in the upload popup, type filters, and a direct upload's "Change
// type" action — system types are locked and never appear here. Ids are
// slugged from the label at add time (falling back to a short random suffix
// on collision/empty), and every file stores the id, not the label — a
// rename just edits settings.documentTypes, no file rows change.
const DocumentTypesCard: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [types, setTypes] = useState<CustomDocType[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    getDocumentTypes().then(setTypes).catch(() => setTypes([])).finally(() => setLoading(false));
  }, []);

  const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
  const uniqueId = (label: string, existing: CustomDocType[]): string => {
    const base = slugify(label) || 'type';
    return existing.some(t => t.id === base) ? `${base}-${uuidv4().slice(0, 6)}` : base;
  };

  const handleAdd = async () => {
    const label = newLabel.trim();
    if (!label) return;
    setAdding(true);
    try {
      const next = [...types, { id: uniqueId(label, types), label }];
      await saveDocumentTypes(next);
      setTypes(next);
      setNewLabel('');
      toast('Document type added', { type: 'success' });
    } catch {
      toast('Failed to add type', { type: 'error' });
    } finally {
      setAdding(false);
    }
  };

  const startRename = (t: CustomDocType) => { setEditingId(t.id); setEditLabel(t.label); };
  const cancelRename = () => { setEditingId(null); setEditLabel(''); };

  const saveRename = async (id: string) => {
    const label = editLabel.trim();
    if (!label) return;
    setBusyId(id);
    try {
      const next = types.map(t => t.id === id ? { ...t, label } : t);
      await saveDocumentTypes(next);
      setTypes(next);
      cancelRename();
      toast('Renamed', { type: 'success' });
    } catch {
      toast('Failed to rename', { type: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (t: CustomDocType) => {
    setBusyId(t.id);
    try {
      // GET /api/documents can only ask for "archived" or "not archived" in
      // one call (no "either" mode) — sum both so a type still referenced by
      // an archived-only row still blocks deletion (its files would be left
      // with an unresolvable kind id otherwise).
      const [active, archived] = await Promise.all([
        getDocuments({ kinds: [`custom:${t.id}`], limit: 1 }),
        getDocuments({ kinds: [`custom:${t.id}`], limit: 1, archived: true }),
      ]);
      const inUse = active.total + archived.total;
      if (inUse > 0) {
        toast(`In use by ${inUse} document${inUse === 1 ? '' : 's'} — can't delete`, { type: 'error' });
        return;
      }
      const ok = await confirm({
        title: 'Delete document type',
        message: `Delete "${t.label}"? This can't be undone.`,
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (!ok) return;
      const next = types.filter(x => x.id !== t.id);
      await saveDocumentTypes(next);
      setTypes(next);
      toast('Document type deleted', { type: 'success' });
    } catch {
      toast('Failed to delete type', { type: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
      <div className="p-6 border-b border-slate-100 dark:border-slate-700">
        <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Tag size={20} className="text-accent-600" /> Document Types
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Custom types available in the upload popup, the Documents page type filter, and a direct upload's "Change type" action. Built-in types (Invoice, RFI, Punch Report, etc.) are fixed and don't appear here.
        </p>
      </div>
      <div className="p-6 space-y-4">
        {loading ? (
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent-600" />
        ) : types.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">No custom types yet.</p>
        ) : (
          <ul className="space-y-2">
            {types.map(t => (
              <li key={t.id} className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2.5">
                {editingId === t.id ? (
                  <>
                    <input
                      className={inputCls}
                      value={editLabel}
                      onChange={e => setEditLabel(e.target.value)}
                      autoFocus
                      onKeyDown={e => { if (e.key === 'Enter') saveRename(t.id); if (e.key === 'Escape') cancelRename(); }}
                    />
                    <button onClick={() => saveRename(t.id)} disabled={busyId === t.id || !editLabel.trim()}
                      className="shrink-0 text-sm font-medium text-accent-600 hover:text-accent-700 disabled:opacity-50">
                      {busyId === t.id ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={cancelRename} title="Cancel"
                      className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700">
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-white">{t.label}</span>
                    <span className="shrink-0 font-mono text-xs text-slate-400 dark:text-slate-500">custom:{t.id}</span>
                    <button onClick={() => startRename(t)} title="Rename"
                      className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(t)} disabled={busyId === t.id} title="Delete"
                      className="shrink-0 p-1.5 rounded-md text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50">
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2 border-t border-slate-100 dark:border-slate-700 pt-4">
          <input
            className={inputCls}
            placeholder="e.g. Warranty"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          />
          <button onClick={handleAdd} disabled={adding || !newLabel.trim()}
            className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-accent-600 text-white rounded-lg text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50">
            <Plus size={15} /> Add
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

// Kept as a value so a ?tab= param can be validated against it before it is
// trusted to select a tab.
const TAB_IDS = [
  'preferences', 'takeoff-templates', 'general', 'mail', 'storage', 'users', 'aia-template', 'changelog',
] as const;
type TabId = (typeof TAB_IDS)[number];
const isTabId = (v: string | null): v is TabId => !!v && (TAB_IDS as readonly string[]).includes(v);

export const Settings: React.FC = () => {
  const { toast } = useToast();
  const [serverSettings, setServerSettings] = useState<Record<string, string>>({
    appName: 'Takeoff Pro',
    logoUrl: '',
    companyName: '',
    companyPhone: '',
    companyEmail: '',
    companyAddress: '',
    companyBrandColor: '#99CB38',
    invertLogoOnDocuments: 'false',
    publicHost: '',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('preferences');
  const [isAdmin, setIsAdmin] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // The mail OAuth callback lands here as `/settings?tab=mail&connected=<id>`
  // or `&error=<message>` (server/mail/routes.ts). Read once on mount: the
  // result is a toast, so re-running it on every param change would repeat it,
  // and `connected`/`error` are cleared straight afterwards so a reload — or a
  // shared URL — never replays a stale outcome.
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (isTabId(tab)) setActiveTab(tab);

    const connected = searchParams.get('connected');
    const error = searchParams.get('error');
    if (connected) toast('Mail account connected', { type: 'success' });
    if (error) toast(error, { type: 'error' });
    if (connected || error) {
      const next = new URLSearchParams(searchParams);
      next.delete('connected');
      next.delete('error');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        setIsAdmin(user.role === 'admin');
      }
    } catch { /* ignore */ }

    const fetchSettings = async () => {
      try {
        const data = await getSettings();
        setServerSettings(prev => ({ ...prev, ...data }));
      } catch (error) {
        console.error('Failed to fetch settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSettings();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await saveSettings(serverSettings);
      if (serverSettings.appName) document.title = serverSettings.appName;
      toast('Settings saved successfully', { type: 'success' });
    } catch {
      toast('Failed to save settings', { type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setServerSettings(prev => ({ ...prev, logoUrl: reader.result as string }));
      reader.readAsDataURL(file);
    }
  };

  // Admin-only tabs not shown to regular users
  const allTabs: { id: TabId; label: string; icon: React.ReactNode; adminOnly?: boolean }[] = [
    { id: 'preferences', label: 'User Preferences', icon: <User size={18} /> },
    { id: 'takeoff-templates', label: 'Takeoff Templates', icon: <Layout size={18} /> },
    { id: 'general',     label: 'General Settings', icon: <Globe size={18} />,   adminOnly: true },
    { id: 'mail',        label: 'Mail',              icon: <Mail size={18} /> },
    { id: 'storage',     label: 'Storage',           icon: <HardDrive size={18} />, adminOnly: true },
    { id: 'aia-template', label: 'AIA Template',     icon: <FileSpreadsheet size={18} />, adminOnly: true },
    { id: 'users',       label: 'User Management',  icon: <Users size={18} />,   adminOnly: true },
    { id: 'changelog',   label: 'Changelog',         icon: <History size={18} /> },
  ];
  const tabs = allTabs.filter(t => !t.adminOnly || isAdmin);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600" />
      </div>
    );
  }


  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Palette className="text-accent-600" size={24} />
              Settings
            </h1>
            {activeTab === 'general' && isAdmin && (
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-2 px-4 py-2 bg-accent-600 text-white rounded-lg font-medium hover:bg-accent-700 transition-all disabled:opacity-50 shadow-sm"
              >
                <Save size={18} />
                {isSaving ? 'Saving…' : 'Save Changes'}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Sidebar */}
          <aside className="w-full md:w-64 shrink-0">
            <nav className="flex overflow-x-auto no-scrollbar gap-1 md:flex-col md:overflow-visible md:space-y-1 md:gap-0">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all whitespace-nowrap shrink-0 md:w-full ${
                    activeTab === tab.id
                      ? 'bg-accent-600 text-white shadow-md'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 hover:shadow-sm'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </nav>
          </aside>

          {/* Content */}
          <div className="flex-1">
            {activeTab === 'preferences' && <PreferencesTab />}

            {activeTab === 'takeoff-templates' && <TemplatesView />}

            {activeTab === 'general' && isAdmin && (
              <div className="space-y-6">
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">Application Branding</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Customize how the application appears to users.</p>
                  </div>
                  <div className="p-6 space-y-6">
                    <div>
                      <label className={labelCls}>Application Name</label>
                      <input type="text" value={serverSettings.appName}
                        onChange={e => setServerSettings({ ...serverSettings, appName: e.target.value })}
                        className={inputCls} placeholder="e.g. My Custom Takeoff" />
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 italic">
                        Updates the name shown in the navigation bar and browser tab title.
                      </p>
                    </div>
                    <div>
                      <label className={labelCls}>Application Logo</label>
                      <div className="flex items-start gap-6">
                        <div className="w-24 h-24 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex items-center justify-center overflow-hidden shrink-0">
                          {serverSettings.logoUrl
                            ? <img src={serverSettings.logoUrl} alt="Logo Preview" className="max-w-full max-h-full object-contain" />
                            : <ImageIcon className="text-slate-300 dark:text-slate-600" size={32} />}
                        </div>
                        <div className="flex-1">
                          <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" id="logo-upload" />
                          <label htmlFor="logo-upload"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-600 cursor-pointer transition-all shadow-sm">
                            <ImageIcon size={16} /> Upload New Logo
                          </label>
                          {serverSettings.logoUrl && (
                            <button onClick={() => setServerSettings({ ...serverSettings, logoUrl: '' })}
                              className="ml-3 text-sm text-red-500 hover:text-red-600 font-medium">
                              Remove
                            </button>
                          )}
                          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                            Recommended: Square or horizontal logo, transparent background. Max 2MB.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">Contractor Information</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Shown on proposal PDFs generated from projects.</p>
                  </div>
                  <div className="p-6">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      {[
                        { key: 'companyName',    label: 'Company Name', type: 'text',  placeholder: 'e.g. Acme Contracting LLC' },
                        { key: 'companyPhone',   label: 'Phone',        type: 'tel',   placeholder: 'e.g. (555) 123-4567' },
                        { key: 'companyEmail',   label: 'Email',        type: 'email', placeholder: 'e.g. info@acme.com' },
                        { key: 'companyAddress', label: 'Address',      type: 'text',  placeholder: 'e.g. 123 Main St, Springfield, IL' },
                      ].map(field => (
                        <div key={field.key}>
                          <label className={labelCls}>{field.label}</label>
                          <input
                            type={field.type}
                            value={serverSettings[field.key] || ''}
                            onChange={e => setServerSettings({ ...serverSettings, [field.key]: e.target.value })}
                            className={inputCls}
                            placeholder={field.placeholder}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">Document Branding</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Controls the branded header and footer on generated documents (proposals, invoices, change orders, issues, punch lists).</p>
                  </div>
                  <div className="p-6 space-y-6">
                    <div>
                      <label htmlFor="company-brand-color" className={labelCls}>Document Brand Colour</label>
                      <div className="flex items-center gap-3">
                        <input
                          id="company-brand-color"
                          type="color"
                          value={serverSettings.companyBrandColor || '#99CB38'}
                          onChange={e => setServerSettings({ ...serverSettings, companyBrandColor: e.target.value })}
                          className="w-12 h-10 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent cursor-pointer shrink-0"
                          aria-describedby="company-brand-color-hint"
                        />
                        <span className="font-mono text-sm text-slate-700 dark:text-slate-300 uppercase">
                          {serverSettings.companyBrandColor || '#99CB38'}
                        </span>
                      </div>
                      <p id="company-brand-color-hint" className="mt-2 text-xs text-slate-500 dark:text-slate-400 italic">
                        Used for the header/footer accents on generated documents (proposals, invoices, etc.).
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Invert Logo on Documents</p>
                        <p id="invert-logo-hint" className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          Turn on if your logo is dark — it will be shown in white on the dark document header.
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={serverSettings.invertLogoOnDocuments === 'true'}
                        aria-label="Invert logo on documents"
                        aria-describedby="invert-logo-hint"
                        onClick={() => setServerSettings({ ...serverSettings, invertLogoOnDocuments: serverSettings.invertLogoOnDocuments === 'true' ? 'false' : 'true' })}
                        className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${serverSettings.invertLogoOnDocuments === 'true' ? 'bg-accent-600' : 'bg-slate-200 dark:bg-slate-700'}`}
                      >
                        <motion.div layout transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                          className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${serverSettings.invertLogoOnDocuments === 'true' ? 'left-6' : 'left-0.5'}`} />
                      </button>
                    </div>
                  </div>
                </div>

                <DocumentTypesCard />

                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                      <Link size={20} className="text-accent-600" /> Sharing
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Configure the public URL used when generating share links for printouts and project pages.</p>
                  </div>
                  <div className="p-6">
                    <label className={labelCls}>Public Host URL</label>
                    <input
                      type="url"
                      value={serverSettings.publicHost || ''}
                      onChange={e => setServerSettings({ ...serverSettings, publicHost: e.target.value })}
                      className={inputCls}
                      placeholder="e.g. https://takeoff.mydomain.com"
                    />
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      Used to build share links (e.g. <span className="font-mono">https://takeoff.mydomain.com/share/…</span>). If left blank, the app's current origin is used instead.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'mail' && <MailAccountsTab isAdmin={isAdmin} />}

            {activeTab === 'storage' && isAdmin && <StorageTab />}

            {activeTab === 'aia-template' && isAdmin && <AiaTemplateTab />}

            {activeTab === 'users' && isAdmin && (
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden p-6">
                <UsersView />
              </div>
            )}

            {activeTab === 'changelog' && <ChangelogTab />}
          </div>
        </div>
      </main>
    </div>
  );
};
