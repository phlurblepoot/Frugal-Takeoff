import React, { useState, useRef } from 'react';
import { ArrowLeft, FileText, Loader2, Check, Eye, Hash, Search, ZoomIn, ZoomOut, Maximize, X } from 'lucide-react';
import { createWorker } from 'tesseract.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { buildOcrCrop, ocrParamsFor, cleanSheetNumber, cleanDescriptionText } from '../utils/pdf';
import { getImageUrl } from '../utils/store';
import { PdfPagePreview } from './PdfPagePreview';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// Pulls embedded text out of a rectangular region of a PDF page. Coordinates
// are scaled into the same 2.0× viewport space the user's selection rectangle
// lives in (the rectangle is stored as 0–100 percentages of the displayed
// image, and our PdfPagePreview renders at scale=2.0). Any text item whose
// bounding box overlaps the region is included in document order. Returns ''
// when the region has no embedded text — caller falls back to OCR for image-
// only content (scanned drawings, vector-art labels that aren't real text).
async function extractTextFromVectorRegion(
  page: any,
  region: { x: number; y: number; width: number; height: number },
): Promise<string> {
  const viewport = page.getViewport({ scale: 2.0 });
  const regionLeft = (region.x / 100) * viewport.width;
  const regionTop = (region.y / 100) * viewport.height;
  const regionRight = regionLeft + (region.width / 100) * viewport.width;
  const regionBottom = regionTop + (region.height / 100) * viewport.height;

  const textContent = await page.getTextContent();
  const matched: string[] = [];
  for (const item of textContent.items as any[]) {
    const str: string = item.str ?? '';
    if (!str) continue;
    const tx = item.transform?.[4] ?? 0;
    const ty = item.transform?.[5] ?? 0;
    const w = item.width ?? 0;
    // height isn't always populated; fall back to the transform's d component
    // (font size for non-rotated text) which pdf.js always sets.
    const h = item.height || Math.abs(item.transform?.[3] ?? item.transform?.[0] ?? 12);

    // Text baseline lives at (tx, ty) in PDF coords (Y-up). Glyph top is at
    // ty + h. convertToViewportPoint handles page rotation + Y-flip into
    // screen-space coords, so we just take min/max afterwards.
    const [vx0, vy0] = viewport.convertToViewportPoint(tx, ty);
    const [vx1, vy1] = viewport.convertToViewportPoint(tx + w, ty + h);
    const itemLeft = Math.min(vx0, vx1);
    const itemRight = Math.max(vx0, vx1);
    const itemTop = Math.min(vy0, vy1);
    const itemBottom = Math.max(vy0, vy1);

    // Any overlap counts as inside — the user's selection rectangle is loose
    // by nature, and a strict containment test rejects items that protrude a
    // pixel or two beyond the box.
    if (itemRight < regionLeft || itemLeft > regionRight) continue;
    if (itemBottom < regionTop || itemTop > regionBottom) continue;
    matched.push(str);
  }
  return matched.join(' ').trim();
}

// Render a vector PDF page to a JPEG data URL for OCR fallback. Used only
// when extractTextFromVectorRegion returns nothing (image-only pages).
async function renderPdfPageToDataUrl(page: any): Promise<string> {
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport } as any).promise;
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  // Drop the canvas backing store explicitly so a multi-page "extract all"
  // doesn't accumulate ~10 MB per page until GC catches up.
  canvas.width = 0;
  canvas.height = 0;
  return dataUrl;
}

// Shared "name pages" UI used by both the new-project upload flow and the
// add-pages-to-existing-project flow. Owns the preview modal, OCR-region
// drawing, and the Tesseract worker pipeline so the two callers don't end up
// with subtly diverging copies (we hit a bug from exactly that — see commit
// b2ce92d). The caller wraps this component in whatever outer container it
// needs (full page vs. nested in a modal) and supplies the storage handles
// for `pendingPages`.

export interface NamingStepPage {
  id: string;
  name: string;
  pageNumber?: string;
  description?: string;
  imageId: string;
  thumbnailId: string;
  imageWidth: number;
  imageHeight: number;
  sourcePdfFileId?: string;
  sourcePdfPageNum?: number;
  extractedText?: string;
  /** Set in the add-pages-to-existing-project flow when a new page replaces
   *  an existing one (matched by page number). Only the add-pages caller
   *  populates this — the new-project upload leaves it undefined. */
  revisionOf?: string;
}

export interface PageNamingStepProps {
  pendingPages: NamingStepPage[];
  setPendingPages: (pages: NamingStepPage[]) => void;
  pendingThumbnails: Record<string, string>;

  onConfirm: () => void | Promise<void>;
  confirmLabel?: string;
  confirmIcon?: React.ReactNode;
  isConfirming?: boolean;

  title?: string;
  subtitle?: string;
}

export const PageNamingStep: React.FC<PageNamingStepProps> = ({
  pendingPages,
  setPendingPages,
  pendingThumbnails,
  onConfirm,
  confirmLabel = 'Finish',
  confirmIcon,
  isConfirming = false,
  title = 'Name Pages',
  subtitle = 'Review and rename the imported pages.',
}) => {
  // ── Internal UI state — none of this leaks to the parent ─────────────────
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);
  const [extractionType, setExtractionType] = useState<'pageNumber' | 'description' | null>(null);
  const [extractionRect, setExtractionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [interactionMode, setInteractionMode] = useState<'draw' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se' | null>(null);
  const [initialRect, setInitialRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number } | null>(null);

  const imageContainerRef = useRef<HTMLDivElement>(null);

  // ── Field editing ─────────────────────────────────────────────────────────
  // Updates one field on one page, auto-syncing the displayed name from
  // pageNumber + description. Identical logic was previously inlined in both
  // callers — now lives here so they can't drift.
  const updateField = (id: string, field: keyof NamingStepPage, value: string) => {
    setPendingPages(pendingPages.map(p => {
      if (p.id !== id) return p;
      const updated: NamingStepPage = { ...p, [field]: value } as NamingStepPage;
      if (field === 'pageNumber' || field === 'description') {
        const num = field === 'pageNumber' ? value : (p.pageNumber || '');
        const desc = field === 'description' ? value : (p.description || '');
        updated.name = num && desc ? `${num} - ${desc}` : (num || desc || p.name);
      }
      return updated;
    }));
  };

  const closePreview = () => {
    setPreviewPageId(null);
    setExtractionRect(null);
    setExtractionType(null);
    setIsSelecting(false);
    setInteractionMode(null);
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  };

  // ── Extraction ────────────────────────────────────────────────────────────
  // Two paths, in this preference order, per page:
  //   1. Vector path: read embedded text from the source PDF inside the
  //      selection region. This is what makes "A5.0" come back as "A5.0"
  //      rather than the OCR misread "AS.0" — we're reading the same bytes
  //      that CAD wrote, not pixels.
  //   2. OCR fallback: only spun up when (a) the page has no source PDF
  //      (legacy projects) or (b) the region has no embedded text at all
  //      (scanned drawings, vector-art labels that aren't real text). For
  //      vector pages we render the page to a JPEG on demand so the OCR
  //      crop is full-resolution — fixes "extract all pages" producing
  //      gibberish on non-previewed pages, which were previously being
  //      cropped from the 400px thumbnail.
  const handleExtractText = async (applyToAll: boolean) => {
    if (!previewPageId || !extractionRect || !extractionType) return;
    const previewedPage = pendingPages.find(p => p.id === previewPageId);
    if (!previewedPage) return;

    const mode = extractionType;
    const region = { ...extractionRect };
    const cleanValue = (t: string) =>
      mode === 'pageNumber' ? cleanSheetNumber(t) : cleanDescriptionText(t);

    setIsExtracting(true);

    // Cache PDF proxies + per-page render data URLs so a multi-page extract
    // doesn't reload the same file (or re-render the same page) repeatedly.
    const proxyCache = new Map<string, any>();
    const renderCache = new Map<string, string>(); // key: `${fileId}#${pageNum}`
    const getProxy = async (fileId: string) => {
      let p = proxyCache.get(fileId);
      if (!p) {
        p = await pdfjsLib.getDocument({ url: getImageUrl(fileId) }).promise;
        proxyCache.set(fileId, p);
      }
      return p;
    };

    // Lazy Tesseract worker: many extracts hit the vector path and never
    // need this, so we don't pay the worker-startup tax up front.
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    const getWorker = async () => {
      if (worker) return worker;
      worker = await createWorker('eng', 1, {
        langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
      });
      await worker.setParameters(ocrParamsFor(mode));
      return worker;
    };

    try {
      const recognizePage = async (p: NamingStepPage): Promise<string> => {
        // Vector path: try embedded text first; render+OCR is the fallback.
        if (p.sourcePdfFileId && p.sourcePdfPageNum) {
          try {
            const proxy = await getProxy(p.sourcePdfFileId);
            const pdfPage = await proxy.getPage(p.sourcePdfPageNum);
            const text = await extractTextFromVectorRegion(pdfPage, region);
            if (text) return cleanValue(text);
            const cacheKey = `${p.sourcePdfFileId}#${p.sourcePdfPageNum}`;
            let rendered = renderCache.get(cacheKey);
            if (!rendered) {
              rendered = await renderPdfPageToDataUrl(pdfPage);
              renderCache.set(cacheKey, rendered);
            }
            const cropUrl = await buildOcrCrop(rendered, region);
            const w = await getWorker();
            const { data: { text: ocrText } } = await w.recognize(cropUrl);
            return cleanValue(ocrText || '');
          } catch (err) {
            console.warn('Vector text extract failed; falling back to raster', err);
          }
        }
        // Legacy raster path. Reuse the preview modal's already-loaded image
        // for the active page when possible; otherwise the stored full-size
        // raster URL; thumbnail only as a last resort.
        const srcUrl =
          p.id === previewPageId && previewImageSrc
            ? previewImageSrc
            : p.imageId
            ? getImageUrl(p.imageId)
            : pendingThumbnails[p.thumbnailId];
        if (!srcUrl) return '';
        const cropUrl = await buildOcrCrop(srcUrl, region);
        const w = await getWorker();
        const { data: { text } } = await w.recognize(cropUrl);
        return cleanValue(text || '');
      };

      if (applyToAll) {
        const updated = [...pendingPages];
        for (let i = 0; i < updated.length; i++) {
          const value = await recognizePage(updated[i]);
          const num = mode === 'pageNumber' ? value : (updated[i].pageNumber || '');
          const desc = mode === 'description' ? value : (updated[i].description || '');
          updated[i] = {
            ...updated[i],
            [mode]: value,
            name: num && desc ? `${num} - ${desc}` : (num || desc || updated[i].name),
          };
        }
        setPendingPages(updated);
      } else {
        const value = await recognizePage(previewedPage);
        updateField(previewPageId, mode, value);
      }

      setExtractionRect(null);
      setExtractionType(null);
    } catch (error) {
      console.error('Extraction error:', error);
      alert('Failed to extract text. Please try again.');
    } finally {
      if (worker) {
        try { await worker.terminate(); } catch { /* noop */ }
      }
      for (const p of proxyCache.values()) {
        try { await p.destroy(); } catch { /* noop */ }
      }
      setIsExtracting(false);
    }
  };

  // ── Preview-modal pointer handling ────────────────────────────────────────
  // Coordinates inside the image container are normalised to 0–100 (percentages
  // of the displayed image bounds) so the resulting rect is independent of
  // zoom + pan and feeds straight into buildOcrCrop.
  const handleImageMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (zoom > 1 && !extractionType) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
      return;
    }
    if (!extractionType) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setIsSelecting(true);
    setInteractionMode('draw');
    setSelectionStart({ x, y });
    setExtractionRect({ x, y, width: 0, height: 0 });
  };

  const handleImageMouseMove = (e: React.MouseEvent) => {
    if (isPanning && panStart) {
      setPanOffset({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
      return;
    }
    if (!isSelecting || !selectionStart || !imageContainerRef.current) return;
    const rect = imageContainerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    if (interactionMode === 'draw') {
      const minX = Math.min(selectionStart.x, x);
      const minY = Math.min(selectionStart.y, y);
      const width = Math.abs(x - selectionStart.x);
      const height = Math.abs(y - selectionStart.y);
      setExtractionRect({ x: minX, y: minY, width, height });
    } else if (interactionMode === 'move' && initialRect) {
      const dx = (e.clientX - selectionStart.x) / rect.width * 100;
      const dy = (e.clientY - selectionStart.y) / rect.height * 100;
      setExtractionRect({
        x: Math.max(0, Math.min(100 - initialRect.width, initialRect.x + dx)),
        y: Math.max(0, Math.min(100 - initialRect.height, initialRect.y + dy)),
        width: initialRect.width,
        height: initialRect.height,
      });
    }
  };

  const handleImageMouseUp = () => {
    setIsSelecting(false);
    setIsPanning(false);
    setInteractionMode(null);
    setPanStart(null);
  };

  const handleZoomIn = () => setZoom(z => Math.min(5, z + 0.5));
  const handleZoomOut = () => {
    setZoom(z => {
      const next = Math.max(1, z - 0.5);
      if (next === 1) setPanOffset({ x: 0, y: 0 });
      return next;
    });
  };
  const handleResetZoom = () => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const previewPage = previewPageId ? pendingPages.find(p => p.id === previewPageId) : null;
  const isAreaSelected = !!(extractionRect && extractionRect.width > 0 && extractionRect.height > 0);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="p-4 sm:p-8 border-b border-slate-100 dark:border-slate-700 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">{title}</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>
          </div>
          <button
            onClick={onConfirm}
            disabled={isConfirming}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            {isConfirming ? (
              <><Loader2 size={18} className="animate-spin" /> Saving...</>
            ) : (
              <>{confirmIcon ?? <Check size={18} />} {confirmLabel}</>
            )}
          </button>
        </div>

        <div className="p-4 sm:p-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {pendingPages.map((page, index) => {
              // Look up under thumbnailId first (new uploads + the
              // add-pages-to-existing-project flow), then fall back to
              // imageId (the "rename existing pages" flow keys the dict
              // by the page's imageId because that's the stable ID it
              // already had on the project).
              const thumbSrc =
                pendingThumbnails[page.thumbnailId] || pendingThumbnails[page.imageId];
              return (
              <div
                key={page.id}
                className="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-100 dark:border-slate-700 overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-all duration-300"
              >
                <div
                  className="h-48 bg-slate-100 dark:bg-slate-700 relative flex-shrink-0 border-b border-slate-100 dark:border-slate-700 cursor-pointer overflow-hidden group"
                  onClick={() => setPreviewPageId(page.id)}
                >
                  {thumbSrc ? (
                    <img
                      src={thumbSrc}
                      alt={`Page ${index + 1}`}
                      className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-110"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-400 dark:text-slate-500">
                      <Loader2 size={32} className="animate-spin" />
                    </div>
                  )}

                  <div className="absolute inset-0 bg-accent-600/0 group-hover:bg-accent-600/40 transition-all duration-300 flex flex-col items-center justify-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white opacity-0 group-hover:opacity-100 scale-50 group-hover:scale-100 transition-all duration-300">
                      <Eye size={24} />
                    </div>
                    <span className="text-white text-[10px] font-black uppercase tracking-[0.2em] opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0">
                      Click to Preview
                    </span>
                  </div>

                  <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-md text-accent-600 text-[10px] font-black px-2.5 py-1.5 rounded-lg shadow-sm border border-accent-100">
                    PAGE {index + 1}
                  </div>
                  {page.revisionOf && (
                    <div className="absolute top-3 right-3 bg-amber-500/90 backdrop-blur-md text-white text-[10px] font-black px-2.5 py-1.5 rounded-lg shadow-sm">
                      REVISION
                    </div>
                  )}
                </div>

                <div className="p-5 space-y-5">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Page Number</label>
                      {page.pageNumber && <Check size={12} className="text-green-500" />}
                    </div>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 dark:text-slate-500">
                        <Hash size={14} />
                      </div>
                      <input
                        type="text"
                        value={page.pageNumber || ''}
                        onChange={(e) => updateField(page.id, 'pageNumber', e.target.value)}
                        className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-slate-100 bg-slate-50 focus:bg-white focus:border-accent-500 focus:ring-4 focus:ring-accent-500/10 outline-none transition-all text-sm font-bold text-slate-800 placeholder:text-slate-300 placeholder:font-normal dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500 dark:focus:bg-slate-800"
                        placeholder="e.g. A-101"
                      />
                    </div>
                    {page.revisionOf && (
                      <p className="text-[11px] text-amber-600 dark:text-amber-400 px-1">
                        Replaces existing page {page.revisionOf} — measurements will carry over.
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Description</label>
                      {page.description && <Check size={12} className="text-green-500" />}
                    </div>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 dark:text-slate-500">
                        <FileText size={14} />
                      </div>
                      <input
                        type="text"
                        value={page.description || ''}
                        onChange={(e) => updateField(page.id, 'description', e.target.value)}
                        className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-slate-100 bg-slate-50 focus:bg-white focus:border-accent-500 focus:ring-4 focus:ring-accent-500/10 outline-none transition-all text-sm text-slate-800 placeholder:text-slate-300 dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500 dark:focus:bg-slate-800"
                        placeholder="e.g. Floor Plan"
                      />
                    </div>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Preview modal ────────────────────────────────────────────────── */}
      {previewPageId && previewPage && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4">
          <div className="bg-white dark:bg-slate-800 rounded-none sm:rounded-2xl shadow-2xl w-full max-w-5xl h-full flex flex-col overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-900 gap-2">
              <div className="flex items-center gap-2 sm:gap-4 min-w-0">
                <button onClick={closePreview} className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors flex-shrink-0">
                  <ArrowLeft size={20} />
                </button>
                <h3 className="font-bold text-slate-900 dark:text-white truncate">Page Preview &amp; Extraction</h3>
              </div>
              <div className="flex items-center gap-1 sm:gap-2">
                <div className="flex items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-1">
                  <button onClick={handleZoomOut} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-300 transition-colors" title="Zoom Out">
                    <ZoomOut size={16} />
                  </button>
                  <span className="text-xs font-bold text-slate-500 dark:text-slate-400 w-10 sm:w-12 text-center">{Math.round(zoom * 100)}%</span>
                  <button onClick={handleZoomIn} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-300 transition-colors" title="Zoom In">
                    <ZoomIn size={16} />
                  </button>
                  <button onClick={handleResetZoom} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-300 transition-colors ml-1 border-l border-slate-100 dark:border-slate-700" title="Reset Zoom">
                    <Maximize size={16} />
                  </button>
                </div>
                <button
                  onClick={() => setExtractionType('pageNumber')}
                  className={`px-2 sm:px-4 py-2 rounded-lg text-[11px] sm:text-sm font-bold transition-all ${
                    extractionType === 'pageNumber'
                      ? 'bg-accent-600 text-white shadow-md'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-accent-300'
                  }`}
                >
                  Extract Number
                </button>
                <button
                  onClick={() => setExtractionType('description')}
                  className={`px-2 sm:px-4 py-2 rounded-lg text-[11px] sm:text-sm font-bold transition-all ${
                    extractionType === 'description'
                      ? 'bg-accent-600 text-white shadow-md'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-accent-300'
                  }`}
                >
                  Extract Description
                </button>
                <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1 sm:mx-2" />
                <button onClick={closePreview} className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
                  <X size={22} />
                </button>
              </div>
            </div>

            <div
              className={`flex-grow overflow-hidden relative bg-slate-800 flex items-center justify-center ${
                extractionType ? 'cursor-crosshair' : zoom > 1 ? (isPanning ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'
              }`}
              onMouseMove={handleImageMouseMove}
              onMouseUp={handleImageMouseUp}
              onMouseLeave={handleImageMouseUp}
            >
              <div
                ref={imageContainerRef}
                className="relative transition-transform duration-200 ease-out"
                style={{
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                  transformOrigin: 'center center',
                }}
                onMouseDown={handleImageMouseDown}
              >
                <PdfPagePreview
                  sourcePdfUrl={previewPage.sourcePdfFileId ? getImageUrl(previewPage.sourcePdfFileId) : undefined}
                  sourcePdfPageNum={previewPage.sourcePdfPageNum}
                  fallbackUrl={previewPage.imageId
                    ? getImageUrl(previewPage.imageId)
                    : pendingThumbnails[previewPage.thumbnailId]}
                  alt="Preview"
                  className="max-w-full max-h-[80vh] object-contain select-none shadow-2xl"
                  onLoadedSrc={setPreviewImageSrc}
                />
                {extractionRect && (
                  <div
                    className="absolute border-accent-500 bg-accent-500/10 pointer-events-none"
                    style={{
                      left: `${extractionRect.x}%`,
                      top: `${extractionRect.y}%`,
                      width: `${extractionRect.width}%`,
                      height: `${extractionRect.height}%`,
                      borderStyle: 'solid',
                      borderWidth: `${1 / zoom}px`,
                    }}
                  />
                )}
              </div>
            </div>

            <div className="p-4 sm:p-6 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
              <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <div className={`w-2 h-2 rounded-full ${isAreaSelected ? 'bg-green-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
                {isAreaSelected
                  ? `Area selected. Ready to extract${extractionType === 'pageNumber' ? ' page number' : extractionType === 'description' ? ' description' : ''}.`
                  : extractionType
                  ? `Draw a box around the ${extractionType === 'pageNumber' ? 'page number' : 'description'} to extract.`
                  : 'Select Extract Number or Extract Description, then draw a box.'}
              </div>
              <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                <button
                  onClick={() => setExtractionRect(null)}
                  disabled={!extractionRect || isExtracting}
                  className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  Clear Selection
                </button>
                <button
                  onClick={() => handleExtractText(false)}
                  disabled={!isAreaSelected || !extractionType || isExtracting}
                  className="px-4 sm:px-6 py-2 bg-slate-800 dark:bg-slate-700 text-white rounded-lg text-sm font-bold hover:bg-slate-900 dark:hover:bg-slate-600 transition-all flex items-center gap-2 disabled:opacity-50"
                >
                  {isExtracting ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                  Extract Current
                </button>
                <button
                  onClick={() => handleExtractText(true)}
                  disabled={!isAreaSelected || !extractionType || isExtracting}
                  className="px-4 sm:px-6 py-2 bg-accent-600 text-white rounded-lg text-sm font-bold hover:bg-accent-700 transition-all flex items-center gap-2 shadow-lg shadow-accent-200 disabled:opacity-50"
                >
                  {isExtracting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  Extract All Pages
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
