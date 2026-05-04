import React, { useState, useEffect, useCallback } from 'react';
import { Globe, Image as ImageIcon, Users, History, User, Palette, Sun, Moon, Check, Zap, ZapOff, Save, Link, Mail, Plus, Trash2, RefreshCw, CheckCircle, XCircle, ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { getSettings, saveSettings, getSmtpSettings, saveSmtpSettings, testSmtpConnection, getEmailAccounts, createEmailAccount, updateEmailAccount, deleteEmailAccount, testImapAccount, pollEmailNow } from '../utils/store';
import { EmailAccount, SmtpSettings } from '../types';
import { UsersView } from './UsersView';
import { useTheme, AccentKey } from '../context/ThemeContext';

// ── Changelog data ────────────────────────────────────────────────────────────

interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

const CHANGELOG: ChangelogEntry[] = [
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

const POLL_INTERVALS = [
  { label: 'Disabled', value: '0' },
  { label: 'Every 5 minutes', value: '5' },
  { label: 'Every 15 minutes', value: '15' },
  { label: 'Every 30 minutes', value: '30' },
  { label: 'Every hour', value: '60' },
];

const inputCls = 'w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none transition-all';
const labelCls = 'block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider';

interface ImapAccountFormProps {
  initial?: Partial<EmailAccount>;
  onSave: (data: Omit<EmailAccount, 'id' | 'createdAt'>) => Promise<void>;
  onCancel: () => void;
}

const ImapAccountForm: React.FC<ImapAccountFormProps> = ({ initial, onSave, onCancel }) => {
  const [form, setForm] = useState({
    label: initial?.label || '',
    host: initial?.host || '',
    port: initial?.port?.toString() || '993',
    secure: initial?.secure !== false,
    username: initial?.username || '',
    password: initial?.password || '',
    folder: initial?.folder || 'INBOX',
  });
  const [saving, setSaving] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const set = (k: string, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({ ...form, port: parseInt(form.port) || 993, secure: form.secure });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-700">
      <div>
        <label className={labelCls}>Provider</label>
        <select
          className={inputCls}
          defaultValue=""
          onChange={e => {
            const preset = IMAP_PRESETS[e.target.value];
            if (preset) { set('host', preset.host); set('port', preset.port.toString()); set('secure', preset.secure); }
          }}
        >
          <option value="">Custom / Other</option>
          <option value="gmail">Gmail</option>
          <option value="outlook">Outlook / Hotmail / Microsoft 365</option>
          <option value="yahoo">Yahoo Mail</option>
          <option value="icloud">Apple iCloud Mail</option>
        </select>
        <p className="mt-1 text-xs text-slate-400">Selecting a provider fills in the server settings automatically. Refer to the Setup Guide below for credentials help.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Account Label</label>
          <input className={inputCls} value={form.label} onChange={e => set('label', e.target.value)} placeholder="e.g. Work Gmail" required />
        </div>
        <div>
          <label className={labelCls}>Folder / Label to watch</label>
          <input className={inputCls} value={form.folder} onChange={e => set('folder', e.target.value)} placeholder="e.g. Bid Invitations" required />
          <p className="mt-1 text-xs text-slate-400">Gmail: enter the exact label name. Outlook/Yahoo: enter the folder name. Create a filter to route bid emails there first.</p>
        </div>
        <div>
          <label className={labelCls}>IMAP Server</label>
          <input className={inputCls} value={form.host} onChange={e => set('host', e.target.value)} placeholder="imap.gmail.com" required />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className={labelCls}>Port</label>
            <input className={inputCls} type="number" value={form.port} onChange={e => set('port', e.target.value)} placeholder="993" required />
          </div>
          <div className="flex flex-col justify-end pb-0.5">
            <label className={labelCls}>SSL</label>
            <button type="button" onClick={() => set('secure', !form.secure)}
              className={`px-4 py-2.5 rounded-xl border text-sm font-medium transition-all ${form.secure ? 'bg-accent-600 text-white border-accent-600' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600'}`}>
              {form.secure ? 'SSL/TLS' : 'STARTTLS'}
            </button>
          </div>
        </div>
        <div>
          <label className={labelCls}>Username / Email</label>
          <input className={inputCls} value={form.username} onChange={e => set('username', e.target.value)} placeholder="you@example.com" required />
        </div>
        <div>
          <label className={labelCls}>Password / App Password</label>
          <div className="relative">
            <input className={inputCls + ' pr-12'} type={showPass ? 'text' : 'password'} value={form.password} onChange={e => set('password', e.target.value)} placeholder="••••••••" required={!initial} />
            <button type="button" onClick={() => setShowPass(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {initial && <p className="mt-1 text-xs text-slate-400">Leave blank to keep existing password.</p>}
        </div>
      </div>
      <div className="flex gap-3 justify-end pt-2">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-600 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">Cancel</button>
        <button type="submit" disabled={saving} className="px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50">
          {saving ? 'Saving…' : 'Save Account'}
        </button>
      </div>
    </form>
  );
};

const IMAP_PRESETS: Record<string, { host: string; port: number; secure: boolean }> = {
  gmail:   { host: 'imap.gmail.com',        port: 993, secure: true },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true },
  yahoo:   { host: 'imap.mail.yahoo.com',   port: 993, secure: true },
  icloud:  { host: 'imap.mail.me.com',      port: 993, secure: true },
};

interface ProviderStep { text: string; link?: string; linkText?: string; }
interface ProviderInfo {
  id: string;
  name: string;
  steps: ProviderStep[];
  imap: { host: string; port: number; ssl: string };
  smtp: { host: string; port: number; ssl: string };
  note?: string;
}

const PROVIDER_GUIDE: ProviderInfo[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    note: 'Google no longer allows regular passwords for IMAP — an App Password is required.',
    steps: [
      { text: 'Enable 2-Step Verification', link: 'https://myaccount.google.com/security', linkText: 'myaccount.google.com/security' },
      { text: 'Create an App Password', link: 'https://myaccount.google.com/apppasswords', linkText: 'myaccount.google.com/apppasswords' },
      { text: 'Select "Mail" as the app type and generate — copy the 16-character code shown' },
      { text: 'Enter your Gmail address as the username and the App Password (not your regular password) in the account form above' },
    ],
    imap: { host: 'imap.gmail.com', port: 993, ssl: 'SSL/TLS' },
    smtp: { host: 'smtp.gmail.com', port: 587, ssl: 'STARTTLS' },
  },
  {
    id: 'outlook',
    name: 'Outlook / Hotmail / Microsoft 365',
    steps: [
      { text: 'For personal @outlook.com or @hotmail.com accounts: use your normal password. If 2-Step Verification is on, create an App Password', link: 'https://account.live.com/proofs/AppPassword', linkText: 'account.live.com/proofs/AppPassword' },
      { text: 'For work or school Microsoft 365 accounts: your IT administrator may need to enable IMAP access in the Microsoft 365 admin portal' },
    ],
    imap: { host: 'outlook.office365.com', port: 993, ssl: 'SSL/TLS' },
    smtp: { host: 'smtp.office365.com', port: 587, ssl: 'STARTTLS' },
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    steps: [
      { text: 'Enable IMAP access: in Yahoo Mail go to Settings → More Settings → Mailboxes → enable IMAP access' },
      { text: 'Generate an App Password', link: 'https://login.yahoo.com/account/security', linkText: 'login.yahoo.com/account/security' },
      { text: 'Use your full Yahoo address as the username and the generated App Password in the account form above' },
    ],
    imap: { host: 'imap.mail.yahoo.com', port: 993, ssl: 'SSL/TLS' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 587, ssl: 'STARTTLS' },
  },
  {
    id: 'icloud',
    name: 'Apple iCloud Mail',
    steps: [
      { text: 'Two-factor authentication must be enabled on your Apple ID' },
      { text: 'Sign in and generate an app-specific password', link: 'https://appleid.apple.com', linkText: 'appleid.apple.com' },
      { text: 'Navigate to Sign-In and Security → App-Specific Passwords → Generate an App-Specific Password' },
      { text: 'Use your iCloud address (@icloud.com or @me.com) as the username and the generated password in the account form above' },
    ],
    imap: { host: 'imap.mail.me.com', port: 993, ssl: 'SSL/TLS' },
    smtp: { host: 'smtp.mail.me.com', port: 587, ssl: 'STARTTLS' },
  },
];

const EmailTab: React.FC = () => {
  const [smtp, setSmtp] = useState<Partial<SmtpSettings>>({});
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpTestStatus, setSmtpTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [smtpTestMsg, setSmtpTestMsg] = useState('');
  const [showSmtpPass, setShowSmtpPass] = useState(false);

  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EmailAccount | null>(null);
  const [testingAccount, setTestingAccount] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, 'ok' | 'error'>>({});

  const [pollInterval, setPollInterval] = useState('0');
  const [polling, setPolling] = useState(false);
  const [pollResult, setPollResult] = useState<string>('');

  const [loading, setLoading] = useState(true);
  const [showGuide, setShowGuide] = useState(false);
  const [guideOpenProvider, setGuideOpenProvider] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [smtpData, accts, settings] = await Promise.all([getSmtpSettings(), getEmailAccounts(), fetch('/api/settings', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }).then(r => r.json())]);
      setSmtp(smtpData);
      setAccounts(accts);
      setPollInterval(settings['email.pollIntervalMinutes'] || '0');
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleSmtpSave = async () => {
    setSmtpSaving(true);
    try { await saveSmtpSettings(smtp as Record<string, string>); alert('SMTP settings saved.'); }
    catch { alert('Failed to save SMTP settings.'); }
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

  const handleAddAccount = async (data: Omit<EmailAccount, 'id' | 'createdAt'>) => {
    const acct = await createEmailAccount(data);
    setAccounts(a => [...a, acct]);
    setShowAddAccount(false);
  };

  const handleUpdateAccount = async (data: Omit<EmailAccount, 'id' | 'createdAt'>) => {
    if (!editingAccount) return;
    const updated = await updateEmailAccount({ ...editingAccount, ...data });
    setAccounts(a => a.map(x => x.id === updated.id ? updated : x));
    setEditingAccount(null);
  };

  const handleDeleteAccount = async (id: string) => {
    if (!confirm('Remove this email account?')) return;
    await deleteEmailAccount(id);
    setAccounts(a => a.filter(x => x.id !== id));
  };

  const handleTestAccount = async (id: string) => {
    setTestingAccount(id);
    try {
      await testImapAccount(id);
      setTestResults(r => ({ ...r, [id]: 'ok' }));
    } catch {
      setTestResults(r => ({ ...r, [id]: 'error' }));
    } finally {
      setTestingAccount(null);
    }
  };

  const handleSavePollInterval = async () => {
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ 'email.pollIntervalMinutes': pollInterval }) });
    alert('Polling interval saved. Restart the server for changes to take effect.');
  };

  const handlePollNow = async () => {
    setPolling(true);
    setPollResult('');
    try {
      const r = await pollEmailNow();
      setPollResult(r.imported > 0 ? `Imported ${r.imported} new bid(s).` : 'No new emails found.');
    } catch (e: any) {
      setPollResult(`Error: ${e.message}`);
    } finally {
      setPolling(false);
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

      {/* IMAP accounts */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2"><Mail size={20} className="text-accent-600" /> Inbound Email Monitoring (IMAP)</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Optional. Add email accounts to monitor — new emails in the watched folder automatically appear in the Bid Pipeline.</p>
          </div>
          <button onClick={() => { setShowAddAccount(true); setEditingAccount(null); }} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all">
            <Plus size={16} /> Add Account
          </button>
        </div>
        <div className="divide-y divide-slate-100 dark:divide-slate-700">
          {accounts.length === 0 && !showAddAccount && (
            <div className="p-8 text-center text-slate-400 dark:text-slate-500 text-sm">No email accounts configured. Add one to enable automatic bid import.</div>
          )}
          {accounts.map(acct => (
            <div key={acct.id}>
              {editingAccount?.id === acct.id ? (
                <div className="p-4">
                  <ImapAccountForm initial={acct} onSave={handleUpdateAccount} onCancel={() => setEditingAccount(null)} />
                </div>
              ) : (
                <div className="px-6 py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 dark:text-slate-100">{acct.label}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{acct.username} · {acct.host}:{acct.port} · watching <span className="font-mono text-xs bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded">{acct.folder}</span></p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {testResults[acct.id] === 'ok' && <span className="text-green-500"><CheckCircle size={16} /></span>}
                    {testResults[acct.id] === 'error' && <span className="text-red-500"><XCircle size={16} /></span>}
                    <button onClick={() => handleTestAccount(acct.id)} disabled={testingAccount === acct.id} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all flex items-center gap-1.5">
                      {testingAccount === acct.id ? <RefreshCw size={13} className="animate-spin" /> : <CheckCircle size={13} />} Test
                    </button>
                    <button onClick={() => setEditingAccount(acct)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all">Edit</button>
                    <button onClick={() => handleDeleteAccount(acct.id)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 transition-all"><Trash2 size={15} /></button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {showAddAccount && (
            <div className="p-4">
              <ImapAccountForm onSave={handleAddAccount} onCancel={() => setShowAddAccount(false)} />
            </div>
          )}
        </div>
      </div>

      {/* Provider Setup Guide */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <button onClick={() => setShowGuide(g => !g)} className="w-full p-6 flex items-center justify-between text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Email Provider Setup Guide</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Server settings and setup instructions for Gmail, Outlook, Yahoo, and iCloud.</p>
          </div>
          {showGuide ? <ChevronUp size={20} className="text-slate-400 shrink-0" /> : <ChevronDown size={20} className="text-slate-400 shrink-0" />}
        </button>
        {showGuide && (
          <div className="border-t border-slate-100 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700">
            {PROVIDER_GUIDE.map(provider => (
              <div key={provider.id}>
                <button
                  onClick={() => setGuideOpenProvider(p => p === provider.id ? null : provider.id)}
                  className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-all"
                >
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{provider.name}</span>
                  {guideOpenProvider === provider.id
                    ? <ChevronUp size={16} className="text-slate-400 shrink-0" />
                    : <ChevronDown size={16} className="text-slate-400 shrink-0" />}
                </button>
                {guideOpenProvider === provider.id && (
                  <div className="px-6 pb-6 space-y-4">
                    <div>
                      <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Setup Steps</p>
                      <ol className="space-y-2">
                        {provider.steps.map((step, i) => (
                          <li key={i} className="flex gap-2 text-sm text-slate-700 dark:text-slate-300">
                            <span className="shrink-0 w-5 h-5 rounded-full bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300 text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                            <span>
                              {step.text}
                              {step.link && (
                                <> — <a href={step.link} target="_blank" rel="noopener noreferrer" className="text-accent-600 dark:text-accent-400 hover:underline font-mono text-xs">{step.linkText}</a></>
                              )}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                        <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">IMAP (Incoming Mail)</p>
                        <div className="space-y-1.5 text-sm">
                          <div className="flex justify-between gap-2"><span className="text-slate-500">Server</span><span className="font-mono text-slate-800 dark:text-slate-200 text-xs">{provider.imap.host}</span></div>
                          <div className="flex justify-between gap-2"><span className="text-slate-500">Port</span><span className="font-mono text-slate-800 dark:text-slate-200">{provider.imap.port}</span></div>
                          <div className="flex justify-between gap-2"><span className="text-slate-500">Security</span><span className="font-mono text-slate-800 dark:text-slate-200">{provider.imap.ssl}</span></div>
                        </div>
                      </div>
                      <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                        <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">SMTP (Outgoing Mail)</p>
                        <div className="space-y-1.5 text-sm">
                          <div className="flex justify-between gap-2"><span className="text-slate-500">Server</span><span className="font-mono text-slate-800 dark:text-slate-200 text-xs">{provider.smtp.host}</span></div>
                          <div className="flex justify-between gap-2"><span className="text-slate-500">Port</span><span className="font-mono text-slate-800 dark:text-slate-200">{provider.smtp.port}</span></div>
                          <div className="flex justify-between gap-2"><span className="text-slate-500">Security</span><span className="font-mono text-slate-800 dark:text-slate-200">{provider.smtp.ssl}</span></div>
                        </div>
                      </div>
                    </div>
                    {provider.note && (
                      <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2.5">{provider.note}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Polling interval */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Automatic Polling</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">How often the server checks configured IMAP accounts for new emails. Changes take effect after a server restart.</p>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <label className={labelCls}>Check interval</label>
              <select className={inputCls} value={pollInterval} onChange={e => setPollInterval(e.target.value)}>
                {POLL_INTERVALS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <button onClick={handleSavePollInterval} className="px-4 py-2.5 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all flex items-center gap-2">
              <Save size={16} /> Save
            </button>
          </div>
          <div className="flex items-center gap-4 pt-2 border-t border-slate-100 dark:border-slate-700">
            <button onClick={handlePollNow} disabled={polling || accounts.length === 0} className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-600 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all flex items-center gap-2 disabled:opacity-50">
              <RefreshCw size={16} className={polling ? 'animate-spin' : ''} /> Poll Now
            </button>
            {pollResult && <span className="text-sm text-slate-600 dark:text-slate-400">{pollResult}</span>}
            {accounts.length === 0 && <span className="text-sm text-slate-400">Add an IMAP account first.</span>}
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

// ── Main component ────────────────────────────────────────────────────────────

type TabId = 'preferences' | 'general' | 'email' | 'users' | 'changelog';

export const Settings: React.FC = () => {
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
      alert('Settings saved successfully');
    } catch {
      alert('Failed to save settings');
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
