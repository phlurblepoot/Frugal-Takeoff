// src/pages/documents/previewEngine.ts
// Shared engine behind the Documents hover-card preview and viewer modal
// (docs/superpowers/specs/2026-08-17-document-previews-design.md). Type
// detection is pure; thumbnail generation is lazy (nothing is fetched until
// a caller actually asks for a thumb) and cached in-memory for the session.
//
// pdfjs config mirrors src/pages/project/proposal/shrinkPdf.ts exactly (same
// legacy build + worker import) so the two code paths share one pdf.js
// setup. Byte fetching reuses fetchFileBlob (src/utils/store.ts) — the same
// authenticated fetch PdfEditor uses — rather than a raw fetch call.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { fetchFileBlob } from '../../utils/store';
import { SHEET_MIMES } from './openTarget';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export type PreviewKind = 'image' | 'pdf' | 'sheet' | 'other';

export function previewKindFor(mime: string): PreviewKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (SHEET_MIMES.includes(mime)) return 'sheet';
  return 'other';
}

export type Thumb =
  | { kind: 'image'; url: string }
  | { kind: 'canvas'; dataUrl: string }
  | { kind: 'icon' };

// PDFs over this size skip the hover-preview render entirely (icon +
// "Open to preview" instead) — the viewer modal has no such cap.
export const HOVER_PDF_SIZE_CAP = 15 * 1024 * 1024;

const THUMB_LONG_SIDE = 360;
const CACHE_MAX_ENTRIES = 100;

// Keyed `${id}:${versionNumber}` so an older version's thumb never masks a
// newer upload sharing the same file id. Exported for tests only.
export const _cache: Map<string, Thumb> = new Map();

// In-flight render memo, same key shape as _cache. Covers the hover-then-
// click case: a hover render can still be pending pdfjs work when the user
// clicks to open the modal, and rapid re-hovers can overlap too — without
// this, each concurrent caller would kick off its own fetchFileBlob + pdfjs
// render for the identical bytes. Entries are removed on settle (success OR
// failure) so a failed render doesn't wedge — the next call retries.
const _pending: Map<string, Promise<Thumb>> = new Map();

const cacheKey = (id: string, versionNumber: number): string => `${id}:${versionNumber}`;

function cacheSet(key: string, thumb: Thumb): void {
  // Map preserves insertion order, so the first key is the oldest — good
  // enough eviction without tracking access times separately.
  if (!_cache.has(key) && _cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = _cache.keys().next().value;
    if (oldestKey !== undefined) _cache.delete(oldestKey);
  }
  _cache.set(key, thumb);
}

async function renderPdfThumb(id: string): Promise<Thumb> {
  const blob = await fetchFileBlob(id);
  const bytes = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  try {
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = THUMB_LONG_SIDE / Math.max(vp1.width, vp1.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { kind: 'icon' };
    await page.render({ canvasContext: ctx, viewport: vp } as any).promise;
    return { kind: 'canvas', dataUrl: canvas.toDataURL('image/jpeg', 0.8) };
  } finally {
    try { await pdf.destroy(); } catch { /* ignore */ }
  }
}

export async function getPreviewThumb(
  row: { id: string; versionNumber: number; mime: string; size: number },
  opts?: { forHover?: boolean },
): Promise<Thumb> {
  const kind = previewKindFor(row.mime);
  const key = cacheKey(row.id, row.versionNumber);

  if (kind === 'image') {
    // No fetch: the <img> element loads the raw stream itself. Trivial to
    // recompute (it's just a URL string), so not worth spending eviction
    // budget on.
    return { kind: 'image', url: `/api/images/${row.id}/raw` };
  }

  if (kind !== 'pdf') return { kind: 'icon' };

  const cached = _cache.get(key);
  if (cached) return cached;

  if (opts?.forHover && row.size > HOVER_PDF_SIZE_CAP) {
    // Deliberately not cached (nor memoized) under the file's key: caching
    // this icon would poison the modal path, which must still render the
    // real thumb for the same file/version once opened. Hover-capped
    // requests never reach the fetch below, so there's nothing to dedup.
    return { kind: 'icon' };
  }

  const pending = _pending.get(key);
  if (pending) return pending;

  const promise = renderPdfThumb(row.id)
    .then(thumb => { cacheSet(key, thumb); return thumb; })
    .finally(() => { _pending.delete(key); });
  _pending.set(key, promise);
  return promise;
}

// Pure generation-counter guard: a hover session (or any in-flight async
// render) calls next() when it starts and checks isCurrent(id) before acting
// on its result, so a stale render that resolves after mouse-leave/re-hover
// is silently dropped instead of flashing the wrong thumb.
export function makeGenerationGuard(): { next(): number; isCurrent(id: number): boolean } {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(id: number): boolean {
      return id === current && id !== 0;
    },
  };
}
