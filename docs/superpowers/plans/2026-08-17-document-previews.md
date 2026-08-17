# Document Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hover preview card beside the cursor + centered viewer modal on click for the Documents page, all common types (images first-class, PDFs page-rendered, spreadsheets mini-grid, others details card).

**Architecture:** A shared client-side preview engine (type detection, lazy pdf.js first-page thumbnails, LRU-ish cache, generation-counter aborts, 15MB hover cap) feeds two consumers: a portal hover card with delay/pointer-tracking/clamping, and a viewer modal with type-specific bodies + toolbar. Row click swaps from direct navigation to the modal; old behavior becomes "Open in editor". No server changes.

**Tech Stack:** React + TS, pdfjs-dist legacy build (same config as shrinkPdf.ts), xlsx lib (already a dependency), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-17-document-previews-design.md` — normative; read first.

## Global Constraints

- Branch `testing` (commit; no pushes/PRs mid-plan). Never `crypto.randomUUID` (uuidv4 if needed).
- Hover: ~350ms delay before ANY network/render work; one thumb render in flight; abort-on-leave via generation counter; PDFs > 15 * 1024 * 1024 bytes → icon fallback in HOVER only (modal always renders); no hover on touch devices.
- Bytes only from existing endpoints (`/api/files/:id/content` / `/api/images/:id/raw`); no server/schema changes.
- Cache key `fileId:versionNumber`, in-memory, ~100-entry eviction.
- Context menu / selection / bulk bar / version toggle unchanged; context menu "Open" relabeled "Open in editor".
- `npx vitest run` (928 green at start) + `npx tsc --noEmit` + `npm run build` before every commit; Playwright in Task 3.
- Never touch `data/`.

---

### Task 1: previewEngine

**Files:**
- Create: `src/pages/documents/previewEngine.ts`
- Test: `src/pages/documents/previewEngine.test.ts`

**Interfaces (Produces — Tasks 2/3 rely on exact names):**
```ts
export type PreviewKind = 'image' | 'pdf' | 'sheet' | 'other';
export function previewKindFor(mime: string): PreviewKind;           // image/* → image; application/pdf → pdf; xlsx/xls mimes → sheet; else other
export type Thumb = { kind: 'image'; url: string } | { kind: 'canvas'; dataUrl: string } | { kind: 'icon' };
export const HOVER_PDF_SIZE_CAP = 15 * 1024 * 1024;
export function getPreviewThumb(row: { id: string; versionNumber: number; mime: string; size: number }, opts?: { forHover?: boolean }): Promise<Thumb>;
export function makeGenerationGuard(): { next(): number; isCurrent(id: number): boolean };  // pure, unit-testable
export const _cache: Map<string, Thumb>;                              // exported for tests; key `${id}:${versionNumber}`; evict oldest past 100
```
Behavior: image → `{ kind: 'image', url: '/api/images/<id>/raw' }` (no fetch — the <img> loads it); pdf + forHover + size > cap → icon; pdf otherwise → fetch bytes from `/api/files/<id>/content` (auth: read how PdfEditor/fetchFileBlob fetches and reuse that helper), render page 1 via pdfjs (SAME imports/worker config as `src/pages/project/proposal/shrinkPdf.ts`) to a canvas ~360px long side, `toDataURL('image/jpeg', 0.8)`; sheet/other → icon. Cache canvas/image results; icon results for size-capped hovers are NOT cached as the file's thumb (the modal must still render) — cache key includes a `:hover-icon` marker or simply skip caching icons.

- [ ] **Step 1: Failing tests** (mock fetch + pdfjs — vitest has no canvas; mock `getDocument` to return a fake page whose `render` fills nothing and `getViewport` returns {width:100,height:50}; mock `document.createElement('canvas')` minimal or vi.stub — follow the repo's existing jsdom test setup, see DocumentsPage.test.ts):
```ts
describe('previewKindFor', () => { /* image/png→image, application/pdf→pdf, both xlsx mimes→sheet, text/plain→other */ });
describe('getPreviewThumb', () => {
  it('images resolve to a raw-url thumb without any fetch', async () => {});
  it('hover-capped pdf resolves to icon and does not fetch', async () => {});   // size 16MB, forHover
  it('modal path renders the same big pdf (fetch called)', async () => {});      // no forHover
  it('cache: second call same id+version returns without re-fetch; icon results not cached', async () => {});
  it('eviction keeps the map at ≤100', async () => {});
});
describe('makeGenerationGuard', () => { /* next() invalidates prior ids */ });
```
- [ ] **Step 2: RED.** `npx vitest run src/pages/documents/previewEngine.test.ts`
- [ ] **Step 3: Implement** per Produces block.
- [ ] **Step 4: GREEN + full suites.** **Step 5: Commit** — `feat(documents): preview engine — type detection, lazy pdf thumbs, cache, hover size cap`

---

### Task 2: Hover card + viewer modal + table wiring

**Files:**
- Create: `src/pages/documents/DocumentHoverPreview.tsx`, `src/pages/documents/DocumentViewerModal.tsx`
- Modify: `src/pages/documents/DocumentsTable.tsx` (row hover handlers desktop-only; click → modal; context-menu "Open" → "Open in editor"), `src/pages/documents/DocumentsPage.tsx` (modal state owner if cleaner — implementer's call, state it)

**Interfaces:**
- Consumes: Task 1's engine; existing `openTargetFor` (becomes the modal's + context menu's "Open in editor"); `patchFile` (archive), the bulk bar's single-file download path (reuse its fetch-blob-save helper — extract if inline), source `Link`s, app `Modal` idiom (read MergeCustomerModal / UploadDocumentsModal).
- Produces (Task 3 relies on): testids `doc-hover-preview` (the card), `doc-viewer-modal`, `doc-viewer-download`, `doc-viewer-open-editor`, `doc-viewer-archive`, `doc-viewer-page-next`/`-prev` (pdf only), modal title = file name.
- Hover card: portal to body; shows after 350ms of continuous hover on a row (`onMouseEnter` starts timer + tracks `mousemove`, `onMouseLeave`/scroll/contextmenu/click cancels+hides); positioned at cursor + (16, 16) offset, clamped to viewport; content = thumb (img for image/canvas kinds; icon block for icon kind) + meta strip (name · formatted size · type label from docTypes). Generation guard prevents a stale async thumb from showing after the pointer moved to another row. Touch: guard with a `matchMedia('(hover: hover)')` check — no listeners attached otherwise.
- Viewer modal: opens on row click (which also hides the hover card). Body by `previewKindFor`: image → `<img>` (contained, max-h); pdf → canvas rendered at ~1.5x readable scale with ◀ ▶ page nav + "Page x / y" (render current page on demand via the engine's pdfjs path — add a small `renderPdfPage(bytes|docHandle, pageNum, scale)` helper in the engine if needed, keep the pdf doc handle in modal state so page flips don't refetch); sheet → parse first sheet with the xlsx lib (read how AiaScheduleOfValues parses uploads) and render first 20 rows × 8 cols in a plain table; other → icon + details (name, size, type, project, source, date). Toolbar: Download (blob save), Open in editor (`openTargetFor` semantics — closes modal first), Source (router Link, closes), Archive/Restore per row state via `patchFile` (refresh list after). Esc/✕/backdrop close.
- [ ] **Step 1:** Implement (read DocumentsTable fully; keep the hover handlers off the mobile-card render path entirely). **Step 2:** Any pure position-clamp helper gets a unit test (mirror the RowContextMenu clamp if reusable — reuse it if exported, else extract shared). **Step 3:** `npx vitest run && npx tsc --noEmit && npm run build`. **Step 4: Commit** — `feat(documents): hover preview card + viewer modal (images, pdf page nav, sheet grid)`

---

### Task 3: Playwright + full verification

**Files:**
- Modify: `e2e/documents.spec.ts` (+ seed if needed — the portfolio has an image (issue photo) and PDFs? verify; the printout seed is a real PDF)

- [ ] **Step 1:** Tests: (a) hover an image row (`page.hover` on the row, wait ~400ms) → `doc-hover-preview` visible containing an `img`; move away → hidden; (b) click the row → `doc-viewer-modal` with the image + Download/Open-in-editor buttons; Esc closes; (c) click a PDF row (seeded printout) → modal shows canvas + page nav (single-page: nav hidden or disabled — match implementation, assert accordingly); (d) right-click still opens the context menu and no hover card lingers; (e) "Open in editor" navigates to /tools/pdf for the PDF. Screenshot `test-results/documents-preview.png` with the modal open.
- [ ] **Step 2:** Full verification: `npx vitest run`, `npx tsc --noEmit`, `npx playwright test` (full suite green; documents specs re-run x2 for stability).
- [ ] **Step 3: Commit** — `test(e2e): document preview hover + viewer coverage`

---

## Execution notes

- Waves: T1 → T2 → T3 → final whole-branch review → fix wave if needed → controller full verify → push. No migration; nothing supervised.
