import React, { useState, useEffect, useCallback } from 'react';
import { Globe, Image as ImageIcon, Users, History, User, Palette, Sun, Moon, Check, Zap, ZapOff, Save, Link, Mail, Trash2, RefreshCw, CheckCircle, XCircle, Eye, EyeOff, HardDrive, Sparkles, FileSpreadsheet } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { getSettings, saveSettings, getSmtpSettings, saveSmtpSettings, testSmtpConnection, getStorageStats, formatBytes, StorageStats, getStorageOrphans, cleanupStorageOrphans, saveFile } from '../utils/store';
import { SmtpSettings } from '../types';
import { UsersView } from './UsersView';
import { useTheme, AccentKey } from '../context/ThemeContext';
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
  const { mode, accentColor, reducedMotion, toggleMode, setAccentColor, setReducedMotion } = useTheme();

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
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-4 capitalize">
            Current: <span className="font-medium text-slate-700 dark:text-slate-300">{accentColor}</span>
          </p>
        </div>
      </div>
    </div>
  );
};

// ── Email tab ─────────────────────────────────────────────────────────────────

const inputCls = 'w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none transition-all';
const labelCls = 'block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider';

const EmailTab: React.FC = () => {
  const { toast } = useToast();
  const [smtp, setSmtp] = useState<Partial<SmtpSettings>>({});
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpTestStatus, setSmtpTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [smtpTestMsg, setSmtpTestMsg] = useState('');
  const [showSmtpPass, setShowSmtpPass] = useState(false);

  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const smtpData = await getSmtpSettings();
      setSmtp(smtpData);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleSmtpSave = async () => {
    setSmtpSaving(true);
    try { await saveSmtpSettings(smtp as Record<string, string>); toast('SMTP settings saved.', { type: 'success' }); }
    catch { toast('Failed to save SMTP settings.', { type: 'error' }); }
    finally { setSmtpSaving(false); }
  };

  const handleSmtpTest = async () => {
    setSmtpTestStatus('testing');
    setSmtpTestMsg('');
    try {
      await saveSmtpSettings(smtp as Record<string, string>);
      await testSmtpConnection();
      setSmtpTestStatus('ok');
      setSmtpTestMsg('Connection successful!');
    } catch (e: any) {
      setSmtpTestStatus('error');
      setSmtpTestMsg(e.message || 'Connection failed');
    }
  };

  if (loading) return <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600" /></div>;

  return (
    <div className="space-y-6">
      {/* SMTP */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2"><Mail size={20} className="text-accent-600" /> Outbound Email (SMTP)</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Used to send proposals as email replies. Works with any email provider — use an app-specific password for Gmail or Outlook.</p>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2 grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <label className={labelCls}>SMTP Server</label>
                <input className={inputCls} value={smtp.host || ''} onChange={e => setSmtp(s => ({ ...s, host: e.target.value }))} placeholder="smtp.gmail.com" />
              </div>
              <div>
                <label className={labelCls}>Port</label>
                <input className={inputCls} type="number" value={smtp.port || ''} onChange={e => setSmtp(s => ({ ...s, port: parseInt(e.target.value) || undefined }))} placeholder="587" />
              </div>
            </div>
            <div>
              <label className={labelCls}>Username / Email</label>
              <input className={inputCls} value={smtp.username || ''} onChange={e => setSmtp(s => ({ ...s, username: e.target.value }))} placeholder="you@example.com" />
            </div>
            <div>
              <label className={labelCls}>Password / App Password</label>
              <div className="relative">
                <input className={inputCls + ' pr-12'} type={showSmtpPass ? 'text' : 'password'} value={smtp.password || ''} onChange={e => setSmtp(s => ({ ...s, password: e.target.value }))} placeholder="••••••••" />
                <button type="button" onClick={() => setShowSmtpPass(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showSmtpPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <label className={labelCls}>From Name</label>
              <input className={inputCls} value={smtp.fromName || ''} onChange={e => setSmtp(s => ({ ...s, fromName: e.target.value }))} placeholder="Acme Estimating" />
            </div>
            <div>
              <label className={labelCls}>From Address</label>
              <input className={inputCls} value={smtp.fromAddress || ''} onChange={e => setSmtp(s => ({ ...s, fromAddress: e.target.value }))} placeholder="estimates@acme.com" />
            </div>
            <div className="flex items-end">
              <button type="button" onClick={() => setSmtp(s => ({ ...s, secure: !s.secure }))}
                className={`px-4 py-2.5 rounded-xl border text-sm font-medium transition-all ${smtp.secure ? 'bg-accent-600 text-white border-accent-600' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600'}`}>
                {smtp.secure ? 'SSL/TLS (port 465)' : 'STARTTLS (port 587)'}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3 pt-2">
            <button onClick={handleSmtpSave} disabled={smtpSaving} className="px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50 flex items-center gap-2">
              <Save size={16} /> {smtpSaving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={handleSmtpTest} disabled={smtpTestStatus === 'testing'} className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-600 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all flex items-center gap-2">
              {smtpTestStatus === 'testing' ? <RefreshCw size={16} className="animate-spin" /> : <CheckCircle size={16} />} Test Connection
            </button>
            {smtpTestStatus === 'ok' && <span className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400"><CheckCircle size={15} /> {smtpTestMsg}</span>}
            {smtpTestStatus === 'error' && <span className="flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400"><XCircle size={15} /> {smtpTestMsg}</span>}
          </div>
        </div>
      </div>

    </div>
  );
};

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
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = async () => {
      try {
        const id = `aia-template-${crypto.randomUUID()}`;
        await saveFile(id, reader.result as string);
        await saveSettings({ aiaTemplateFileId: id, aiaTemplateName: file.name });
        setTemplateFileId(id);
        setTemplateName(file.name);
        toast('Template uploaded', { type: 'success' });
      } catch {
        toast('Failed to upload template', { type: 'error' });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // allow re-uploading the same filename
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

// ── Main component ────────────────────────────────────────────────────────────

type TabId = 'preferences' | 'general' | 'email' | 'storage' | 'users' | 'aia-template' | 'changelog';

export const Settings: React.FC = () => {
  const { toast } = useToast();
  const [serverSettings, setServerSettings] = useState<Record<string, string>>({
    appName: 'Takeoff Pro',
    logoUrl: '',
    companyName: '',
    companyPhone: '',
    companyEmail: '',
    companyAddress: '',
    publicHost: '',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('preferences');
  const [isAdmin, setIsAdmin] = useState(false);

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
    { id: 'general',     label: 'General Settings', icon: <Globe size={18} />,   adminOnly: true },
    { id: 'email',       label: 'Email',             icon: <Mail size={18} />,    adminOnly: true },
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
            <nav className="space-y-1">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
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

            {activeTab === 'email' && isAdmin && <EmailTab />}

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
