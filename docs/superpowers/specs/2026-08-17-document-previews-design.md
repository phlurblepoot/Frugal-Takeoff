# Document Previews (Hover Card + Viewer Modal) — Design

Date: 2026-08-17
Status: Approved direction by Nathan (visual mockups — option 1: cursor
tooltip + centered viewer; images explicitly first-class)

## Decisions (agreed with Nathan)

- **Hover**: after a short delay (~350ms) over a Documents row, a small
  preview card (~220px) appears beside the cursor (offset, viewport-clamped,
  follows pointer), showing:
  - images (`image/*`): the image itself (contained), loaded from the raw
    stream endpoint;
  - PDFs: the first page, rendered client-side (pdf.js) at thumbnail scale,
    lazily and cached; PDFs over a size cap (15MB) show an icon +
    "Open to preview" instead (no giant fetch on hover);
  - spreadsheets/other: mime icon + meta (name, size, type, source).
  A one-line meta strip (name · size · type) sits under the preview.
  Card hides on mouse-leave, scroll, right-click, or row click. Hover
  previews never trigger on touch devices.
- **Click** on a row now opens a centered **viewer modal** (replacing the
  direct navigation): large preview area —
  - images at full size (contained, zoom not in v1);
  - PDFs rendered at readable resolution with page ◀ ▶ navigation;
  - spreadsheets: first sheet's leading rows as a mini read-only grid
    (parsed client-side with the existing xlsx lib);
  - other types: icon + details card.
  Toolbar: **Download**, **Open in editor** (the old row-click behavior:
  /tools/pdf, /tools/sheets, or raw tab per `openTargetFor`), **Source**
  link (when present), **Archive/Restore** (policy-gated). Delete/change-type
  stay in the right-click context menu. Esc / ✕ / backdrop click close.
- Context menu, selection checkboxes, bulk bar, version-history toggle: all
  unchanged. The context menu's "Open" item becomes "Open in editor" for
  wording consistency.

## Engine (shared by hover + modal)

- `src/pages/documents/previewEngine.ts`: type detection (image / pdf /
  sheet / other from mime), thumbnail rendering + cache:
  - `getPreviewThumb(fileId, versionNumber, mime, size): Promise<Thumb>`
    where `Thumb = { kind: 'image', url } | { kind: 'canvasDataUrl', dataUrl }
    | { kind: 'icon' }`; cache key `fileId:versionNumber` (Map, in-memory,
    session-lifetime; bounded ~100 entries LRU-ish eviction).
  - Hover renders at most ONE thumb at a time; pending render is aborted/
    ignored on mouse-leave (generation counter — same pattern as the page's
    fetch guards). No network activity until the hover delay elapses.
  - PDF rendering reuses the app's established pdfjs-dist legacy build +
    worker config (same imports as shrinkPdf.ts).
  - Size cap: PDFs with `size > 15MB` → `{ kind: 'icon' }` from the hover
    path; the MODAL always renders (user asked for it).
- Bytes come from the existing streaming endpoints (`/api/files/:id/content`
  or `/api/images/:id/raw`) — no new server code, no server-side
  rasterization, no schema change.

## Components

- `DocumentHoverPreview.tsx`: portal-rendered card; owns delay timer,
  pointer tracking, clamping; consumes previewEngine.
- `DocumentViewerModal.tsx`: modal (app Modal idiom), type-specific body
  (image / pdf-with-page-nav / sheet-grid / details), toolbar wired to
  existing helpers (download = the bulk bar's single-file path;
  archive = patchFile; source = router link; open-in-editor =
  openTargetFor).
- `DocumentsTable.tsx`: row hover handlers (desktop only) + click swaps
  from openTargetFor to opening the modal.

## Testing

- Unit: previewEngine type detection, cache hit/eviction, size-cap branch,
  generation-counter abort (pure parts).
- Playwright: hover a seeded image row → card appears with the image;
  hover-leave hides it; click opens the modal with Download/Open-in-editor
  visible; Esc closes; PDF row's modal shows page nav; big-PDF hover shows
  the icon fallback (seed a size-capped row or stub size); context
  menu/right-click still works and suppresses the hover card.
- Manual (Nathan): feel of the hover delay + card tracking; a real plan PDF
  in the viewer.

## Out of scope (v1)

- Zoom/pan in the viewer; multi-file arrows (option 5's gallery); touch
  hover; server-side thumbnail pregeneration (revisit if hover PDFs feel
  slow at his data size); previews inside the version-history rows.
