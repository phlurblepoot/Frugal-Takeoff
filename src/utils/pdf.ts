import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import Tesseract, { PSM } from 'tesseract.js';

// Background timer worker to prevent throttling in background tabs
let pulseWorker: Worker | null = null;
let pulseId = 0;
const pulseCallbacks = new Map<number, () => void>();

const initPulseWorker = () => {
  if (typeof window === 'undefined' || pulseWorker) return;
  const code = `
    self.onmessage = function(e) {
      setTimeout(() => {
        postMessage(e.data.id);
      }, e.data.delay);
    };
  `;
  const blob = new Blob([code], { type: 'application/javascript' });
  pulseWorker = new Worker(URL.createObjectURL(blob));
  pulseWorker.onmessage = (e) => {
    const id = e.data;
    const callback = pulseCallbacks.get(id);
    if (callback) {
      pulseCallbacks.delete(id);
      callback();
    }
  };
};

const getPulse = (delay = 100) => {
  initPulseWorker();
  return new Promise(resolve => {
    const id = ++pulseId;
    pulseCallbacks.set(id, () => resolve(null));
    pulseWorker!.postMessage({ id, delay });
  });
};

// Polyfill requestAnimationFrame to use our worker when the tab is hidden
// This prevents pdf.js from pausing when the user switches tabs
if (typeof window !== 'undefined') {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = function(callback: FrameRequestCallback): number {
    if (document.hidden) {
      initPulseWorker();
      const id = ++pulseId;
      pulseCallbacks.set(id, () => callback(performance.now()));
      pulseWorker!.postMessage({ id, delay: 16 });
      return id;
    }
    return originalRequestAnimationFrame(callback);
  };
  
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  window.cancelAnimationFrame = function(handle: number): void {
    if (document.hidden && pulseCallbacks.has(handle)) {
      pulseCallbacks.delete(handle);
      return;
    }
    originalCancelAnimationFrame(handle);
  };
}

// Configure the worker to use the local version matching the installed pdfjs-dist version
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export interface PdfPageImage {
  dataUrl: string;
  thumbnailDataUrl: string;
  width: number;
  height: number;
  pageNum: number;
  suggestedName?: string;
  extractedText?: string;
  /** Populated when this page could not be rendered. dataUrl will be empty. */
  error?: string;
}

// Typical architectural/engineering sheet number: 1–3 letters, optional separator, 1–4 digits, optional decimal
const SHEET_RE = /\b([A-Z]{1,3}[-.]?\d{1,4}(?:[.]\d{1,2})?)\b/g;

function findBestSheetNumber(text: string): string | null {
  const matches: string[] = [];
  const re = new RegExp(SHEET_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) matches.push(m[1]);
  if (matches.length === 0) return null;
  const freq = new Map<string, number>();
  for (const s of matches) freq.set(s, (freq.get(s) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const isDefaultName = (s: string) => /^page\s*\d+$/i.test(s.trim());
const stripNum = (text: string, num: string) =>
  text.replace(num, '').replace(/^[\s\-–.:|/]+|[\s\-–.:|/]+$/g, '').trim();

// ── OCR region extraction helpers ─────────────────────────────────────────────

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for OCR'));
    img.src = src;
  });

/**
 * Crop a rectangular region (given as percentages 0–100 of the source image)
 * and return a PNG data URL that has been upscaled and contrast-enhanced so
 * Tesseract can read small sheet numbers reliably.
 */
export async function buildOcrCrop(
  imageUrl: string,
  region: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const img = await loadImage(imageUrl);
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;

  const sx = Math.max(0, (region.x / 100) * naturalW);
  const sy = Math.max(0, (region.y / 100) * naturalH);
  const sw = Math.max(1, Math.min(naturalW - sx, (region.width / 100) * naturalW));
  const sh = Math.max(1, Math.min(naturalH - sy, (region.height / 100) * naturalH));

  // Upscale so the shortest side of the crop is at least ~160px — Tesseract is
  // far more accurate when glyphs are large. Cap the multiplier to keep memory sane.
  const upscale = Math.min(6, Math.max(1, 160 / Math.min(sw, sh)));
  const dw = Math.max(1, Math.round(sw * upscale));
  const dh = Math.max(1, Math.round(sh * upscale));

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create canvas context for OCR');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);

  // Grayscale first; track the brightness range so we can stretch contrast.
  const imageData = ctx.getImageData(0, 0, dw, dh);
  const d = imageData.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    d[i] = d[i + 1] = d[i + 2] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  // Only stretch when there is real contrast — otherwise a near-blank crop would
  // be pushed to solid black, which is worse for OCR than leaving it alone.
  const span = max - min;
  if (span >= 16) {
    for (let i = 0; i < d.length; i += 4) {
      let v = ((d[i] - min) / span) * 255;
      v = 255 * Math.pow(Math.max(0, Math.min(1, v / 255)), 1.25);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Tesseract parameters tuned for the kind of text being extracted. */
export function ocrParamsFor(mode: 'pageNumber' | 'description'): { tessedit_char_whitelist: string; tessedit_pageseg_mode: PSM } {
  return mode === 'pageNumber'
    ? {
        // Sheet numbers are short uppercase codes (e.g. A1.1, S-201, M2.3).
        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.-/ ',
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
      }
    : {
        tessedit_char_whitelist: '',
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      };
}

/** Clean up Tesseract output for a sheet number: uppercase, drop spaces, trim stray punctuation.
 *  In the numeric body (after the 1-3 letter prefix), common letter/digit OCR confusions are
 *  corrected: S→5, G→6, O→0, I→1, B→8, Z→2. */
export function cleanSheetNumber(raw: string): string {
  const upper = (raw || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9.\-/]/g, '')
    .replace(/^[.\-/]+|[.\-/]+$/g, '')
    .trim();

  if (!upper) return '';

  // Sheet numbers follow <letters><sep><digits>. In the digit body, apply position-aware
  // substitutions: letters that look like digits are almost certainly digit misreads there.
  const DIGIT_SUBS: Record<string, string> = { S: '5', G: '6', O: '0', I: '1', B: '8', Z: '2' };
  return upper.replace(/^([A-Z]{1,3})([-./]?)(.*)$/, (_, prefix, sep, body) =>
    prefix + sep + body.replace(/[SGOIBZ]/g, (c: string) => DIGIT_SUBS[c] ?? c)
  );
}

/** Clean up Tesseract output for a free-text description. */
export function cleanDescriptionText(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * Attempt to auto-detect a sheet number and description from available metadata.
 * Priority: PDF page labels → filename → repeated tokens in extracted text.
 * Returns empty strings when nothing reliable is found.
 */
export function detectPageInfo(
  suggestedName: string | undefined,
  filename: string,
  extractedText: string | undefined
): { pageNumber: string; description: string } {
  // 1. PDF labels / outline (from getPageLabels)
  if (suggestedName && !isDefaultName(suggestedName)) {
    const num = findBestSheetNumber(suggestedName);
    if (num) return { pageNumber: num, description: stripNum(suggestedName, num) };
    // Non-trivial name but no number pattern — use as description only
  }

  // 2. Filename (underscores → spaces, strip extension)
  const basename = filename.replace(/\.[^.]+$/, '').replace(/_+/g, ' ');
  if (basename && !isDefaultName(basename)) {
    const num = findBestSheetNumber(basename);
    if (num) return { pageNumber: num, description: stripNum(basename, num) };
  }

  // 3. Extracted text — only trust matches that appear more than once,
  //    as repeated codes are far more likely to be sheet numbers than
  //    random drawing content (dimensions, model numbers, etc.)
  if (extractedText && extractedText.trim().length > 4) {
    const matches: string[] = [];
    const re = new RegExp(SHEET_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(extractedText)) !== null) matches.push(m[1]);
    const freq = new Map<string, number>();
    for (const s of matches) freq.set(s, (freq.get(s) || 0) + 1);
    const repeated = [...freq.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
    if (repeated.length > 0) {
      return {
        pageNumber: repeated[0][0],
        description: suggestedName && !isDefaultName(suggestedName) ? suggestedName : '',
      };
    }
  }

  // 4. Nothing detected
  return {
    pageNumber: '',
    description: suggestedName && !isDefaultName(suggestedName) ? suggestedName : '',
  };
}

export const loadPdfPagesGenerator = async function*(
  file: File,
  onProgress?: (status: string, pageNum: number, totalPages: number) => void,
  pageNums?: number[]
): AsyncGenerator<PdfPageImage, void, unknown> {
  const fileUrl = URL.createObjectURL(file);
  const getPdfDoc = () => pdfjsLib.getDocument({
    url: fileUrl,
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.5.207/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.5.207/standard_fonts/',
    disableFontFace: true,
  }).promise;

  let pdf = await getPdfDoc();
  const totalPages = pdf.numPages;

  // When `pageNums` is supplied (retry path), iterate only those pages —
  // deduped, in-range, in sorted order. Otherwise process every page.
  const indices: number[] = pageNums
    ? [...new Set(pageNums)].filter(n => Number.isInteger(n) && n >= 1 && n <= totalPages).sort((a, b) => a - b)
    : Array.from({ length: totalPages }, (_, i) => i + 1);

  let pageLabels: string[] | null = null;
  try {
    pageLabels = await pdf.getPageLabels();
  } catch (e) {
    console.warn('Could not get page labels', e);
  }

  let tesseractWorker: Tesseract.Worker | null = null;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const thumbCanvas = document.createElement('canvas');
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });

  if (!context || !thumbCtx) {
    throw new Error('Could not create canvas context');
  }

  const renderOnePage = async (i: number): Promise<PdfPageImage> => {
    const page = await pdf.getPage(i);

    const scale = 2.0;
    const viewport = page.getViewport({ scale });

    canvas.height = viewport.height;
    canvas.width = viewport.width;
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: context, viewport, intent: 'print' } as any).promise;

    if (onProgress) onProgress('reading the text', i, totalPages);
    let extractedText = '';
    try {
      const textContent = await page.getTextContent();
      extractedText = textContent.items.map((item: any) => item.str).join(' ');
    } catch (e) {
      console.warn('Could not extract text from page', e);
    }

    // Fallback to OCR when no embedded text is available (image-based PDFs).
    if (!extractedText || extractedText.trim().length < 5) {
      if (onProgress) onProgress('reading the text', i, totalPages);
      try {
        if (!tesseractWorker) {
          tesseractWorker = await Tesseract.createWorker('eng', 1, {
            langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
          });
        }
        const { data: { text } } = await tesseractWorker.recognize(canvas);
        extractedText = text;

        if (i % 10 === 0) {
          await tesseractWorker.terminate();
          tesseractWorker = null;
        }
      } catch (ocrError) {
        console.warn('OCR failed', ocrError);
      }
    }

    let suggestedName = `Page ${i}`;
    if (totalPages === 1) {
      suggestedName = file.name.replace(/\.[^/.]+$/, '');
    } else if (pageLabels && pageLabels[i - 1]) {
      suggestedName = pageLabels[i - 1];
    }

    const thumbScale = 400 / Math.max(viewport.width, viewport.height);
    thumbCanvas.width = viewport.width * thumbScale;
    thumbCanvas.height = viewport.height * thumbScale;
    thumbCtx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    const thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.5);

    page.cleanup();

    return {
      dataUrl,
      thumbnailDataUrl,
      width: viewport.width,
      height: viewport.height,
      pageNum: i,
      suggestedName,
      extractedText,
    };
  };

  // Re-open the underlying pdf document — used both for periodic memory recycling
  // and to recover the worker after a failed page render.
  const reopenPdf = async () => {
    try { await pdf.destroy(); } catch { /* ignore */ }
    pdf = await getPdfDoc();
  };

  try {
    let processed = 0;
    for (const i of indices) {
      processed++;
      if (onProgress) onProgress('processing the image', i, totalPages);

      let result: PdfPageImage | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        try {
          result = await renderOnePage(i);
          lastError = null;
        } catch (err) {
          lastError = err;
          console.warn(`Page ${i} render failed (attempt ${attempt + 1})`, err);
          if (attempt === 0) {
            // The pdf.js worker may have been torn down. Rebuild the document
            // and pause briefly before retrying.
            try { await reopenPdf(); } catch (reopenErr) {
              console.warn('PDF reopen failed during retry', reopenErr);
            }
            await getPulse(250);
          }
        }
      }

      if (!result) {
        // Yield a placeholder so the consumer can verify totals and report failures.
        result = {
          dataUrl: '',
          thumbnailDataUrl: '',
          width: 0,
          height: 0,
          pageNum: i,
          error: String((lastError as any)?.message || lastError || 'Unknown render error'),
        };
      }

      if (processed % 10 === 0 && typeof pdf.cleanup === 'function') {
        try { await pdf.cleanup(); } catch (e) { console.warn('pdf.cleanup failed', e); }
      }

      if (processed % 50 === 0 && processed < indices.length) {
        try { await reopenPdf(); } catch (e) { console.warn('pdf reload failed', e); }
      }

      yield result;

      // Small delay to allow garbage collection and UI updates.
      await getPulse(100);
    }
  } finally {
    if (tesseractWorker) {
      try { await tesseractWorker.terminate(); } catch { /* ignore */ }
    }
    try { await pdf.destroy(); } catch { /* ignore */ }
    URL.revokeObjectURL(fileUrl);

    canvas.width = 0;
    canvas.height = 0;
    thumbCanvas.width = 0;
    thumbCanvas.height = 0;
  }
};
