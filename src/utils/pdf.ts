import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import Tesseract, { PSM } from 'tesseract.js';
import type { ExtractConfidence } from './extractMatch';

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
  // Legacy field — only populated when callers explicitly opt in via includeFullPageRaster.
  // The vector pipeline leaves this empty; pages are rendered on demand from the source PDF.
  dataUrl: string;
  thumbnailDataUrl: string;
  width: number;
  height: number;
  pageNum: number;
  suggestedName?: string;
  extractedText?: string;
  /** Sheet number auto-detected from positional text analysis. Empty when no confident match. */
  detectedPageNumber?: string;
  /** Drawing title auto-detected from positional text analysis. Empty when no confident match. */
  detectedDescription?: string;
  /** Confidence of the auto-detection for this page. 'high' when embedded
   *  (vector) text produced a clean sheet number via positional analysis;
   *  'low' when detection fell back to OCR or filename/label heuristics.
   *  Task 7's review UI uses this to flag low-confidence rows. */
  detectionConfidence?: ExtractConfidence;
  /** Medium-resolution JPEG (~1600px long side) for local AI sheet reading.
   *  Only produced when the caller opts in via includeAiImage; transient (not
   *  stored) — the 400px thumbnail is too low-res for the model to read a title
   *  block, so this is sent to /api/ai/read-sheet instead. */
  aiImageDataUrl?: string;
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

// ── Positional text analysis ─────────────────────────────────────────────────
// Plans frequently place the sheet description NOT in the title block but
// directly under the drawing it labels (e.g. "NORTH ELEVATION" centered under
// an elevation, "DETAIL A" under a detail). Position-only heuristics on the
// title block therefore miss the most useful description. Instead we score
// every text item on the page and pick the highest-scoring one — wherever it
// lives — using font size, isolation, all-caps form, and drawing-vocabulary
// keywords as signals.

export interface PositionedText {
  str: string;
  /** Viewport-space coordinates (top-left of glyph box). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pull positioned text items out of a pdf.js TextContent object. The viewport
 *  must be the same one rendered to the user (typically scale 2.0) so the
 *  coordinates are consistent with what the rest of the pipeline uses. */
export function getPositionedText(textContent: any, viewport: any): PositionedText[] {
  const out: PositionedText[] = [];
  for (const item of textContent.items as any[]) {
    const str: string = (item.str ?? '').trim();
    if (!str) continue;
    const tx = item.transform?.[4] ?? 0;
    const ty = item.transform?.[5] ?? 0;
    const w = item.width ?? 0;
    // pdf.js sometimes leaves height at 0; fall back to the font-size term in
    // the text matrix (d for non-rotated, |a| as last resort).
    const h = item.height || Math.abs(item.transform?.[3] ?? item.transform?.[0] ?? 12);
    const [vx0, vy0] = viewport.convertToViewportPoint(tx, ty);
    const [vx1, vy1] = viewport.convertToViewportPoint(tx + w, ty + h);
    out.push({
      str,
      x: Math.min(vx0, vx1),
      y: Math.min(vy0, vy1),
      width: Math.abs(vx1 - vx0),
      height: Math.abs(vy1 - vy0),
    });
  }
  return out;
}

// Strict whole-string sheet number form. Used as a stronger signal than the
// loose SHEET_RE which permits embedded matches.
const SHEET_RE_STRICT = /^[A-Z]{1,3}[-.]?\d{1,4}(?:[.]\d{1,2})?$/;

// Words that look title-ish on their own but are title-block boilerplate, not
// real drawing titles. Compared case-insensitively against the trimmed item.
const BOILERPLATE_RE = /^(SHEET|SHEETS|NO|NO\.|#|DRAWN|CHECKED|SCALE|DATE|PROJECT|OF|REV|REVISION|ISSUE|ISSUED|TITLE|FILE|JOB|BY|FOR|AS|SHOWN|NTS|N\.T\.S\.?|JOB#|DWG|PAGE|REVISIONS?|APPROVED|DESIGNED|PHASE|SET)$/i;

const DATE_LIKE_RE = /^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/;

// Drawing-type vocabulary. Strong signal that a text run is a real title.
const TITLE_KEYWORDS_RE = /\b(PLAN|PLANS|ELEVATION|ELEVATIONS|SECTION|SECTIONS|DETAIL|DETAILS|VIEW|VIEWS|SCHEDULE|SCHEDULES|DIAGRAM|DIAGRAMS|NOTES|LEGEND|KEY|KEYNOTES|ROOF|SITE|FLOOR|FRAMING|FOUNDATION|EXTERIOR|INTERIOR|REFLECTED|CEILING|ELECTRICAL|MECHANICAL|PLUMBING|STRUCTURAL|DEMOLITION|DEMO|ENLARGED|TYPICAL|NORTH|SOUTH|EAST|WEST|FINISH|FINISHES|LIGHTING|POWER|TITLE|COVER|INDEX|ARCHITECTURAL|LANDSCAPE|GENERAL|GRADING|DRAINAGE|UTILITIES|PARTITION|EGRESS|LIFE\s*SAFETY|FIRE|HVAC|RCP)\b/i;

/** Detect the sheet number on a page using positional text items. Returns ''
 *  when no candidate scores above the noise threshold. */
export function detectSheetNumberFromItems(
  items: PositionedText[],
  pageW: number,
  pageH: number,
): string {
  if (!items.length || pageW <= 0 || pageH <= 0) return '';

  // Pre-count substring occurrences so the title-block sheet number — which
  // typically appears in both the title block and as a reference elsewhere —
  // gets a frequency boost over one-off mentions in keynotes.
  const valueCounts = new Map<string, number>();
  const countOccurrence = (val: string) => {
    if (valueCounts.has(val)) return;
    let n = 0;
    for (const o of items) if (o.str.includes(val)) n++;
    valueCounts.set(val, n);
  };

  let best: { value: string; score: number } | null = null;

  for (const item of items) {
    // Whole-string match is a much stronger signal than an embedded match.
    const whole = item.str.match(SHEET_RE_STRICT);
    const candidates: { value: string; wholeMatch: boolean }[] = [];
    if (whole) {
      candidates.push({ value: whole[0], wholeMatch: true });
    } else {
      const re = new RegExp(SHEET_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(item.str)) !== null) {
        candidates.push({ value: m[1], wholeMatch: false });
      }
    }

    for (const { value, wholeMatch } of candidates) {
      countOccurrence(value);
      const cx = (item.x + item.width / 2) / pageW;
      const cy = (item.y + item.height / 2) / pageH;
      // Bottom-right is the typical title-block corner, but engineering plans
      // also use far-right strips that span the full height — so weight right
      // a bit more than bottom.
      let score = cx * 3 + cy * 2;
      // Larger text is more likely a title-block-rendered sheet number than a
      // body-text mention.
      score += (item.height / pageH) * 80;
      if (wholeMatch) score += 4;
      const occ = valueCounts.get(value) || 0;
      score += Math.min(occ - 1, 4) * 0.6;
      if (!best || score > best.score) best = { value, score };
    }
  }

  return best ? best.value : '';
}

/** Detect a drawing title anywhere on the page. Designed to handle the
 *  elevation-style case where the description sits under the drawing rather
 *  than in the title block. */
export function detectDescriptionFromItems(
  items: PositionedText[],
  pageW: number,
  pageH: number,
  sheetNumber: string,
): string {
  if (!items.length || pageH <= 0) return '';

  let best: { text: string; score: number } | null = null;

  for (const item of items) {
    const text = item.str;
    if (text.length < 4 || text.length > 80) continue;
    if (/^\d+$/.test(text)) continue;
    if (DATE_LIKE_RE.test(text)) continue;
    if (BOILERPLATE_RE.test(text)) continue;
    if (SHEET_RE_STRICT.test(text)) continue;
    if (sheetNumber && text === sheetNumber) continue;
    // Skip pure URLs / emails / file paths
    if (/[@/\\]/.test(text) && !/\s/.test(text)) continue;

    // Base score: relative font size. Title text is reliably 2–4× annotation
    // text on architectural plans.
    let score = (item.height / pageH) * 120;
    if (/^[A-Z][A-Z0-9\s\-.,()/&'"#]+$/.test(text)) score += 4;
    if (TITLE_KEYWORDS_RE.test(text)) score += 8;
    // Long strings are almost always running notes, not titles.
    if (text.length > 40) score -= 3;
    if (text.length > 60) score -= 3;
    // Very top of page is usually firm name / project header, not a sheet title.
    const cy = (item.y + item.height / 2) / pageH;
    if (cy < 0.06) score -= 4;
    if (!best || score > best.score) best = { text, score };
  }

  // Reject low-confidence picks — better to leave the field blank than fill
  // it with random annotation text the user has to manually clear.
  if (best && best.score >= 5) return best.text;
  return '';
}

/**
 * Attempt to auto-detect a sheet number and description from available metadata.
 * Priority: PDF page labels → filename → repeated tokens in extracted text.
 * Returns empty strings when nothing reliable is found.
 */
export function detectPageInfo(
  suggestedName: string | undefined,
  filename: string,
  extractedText: string | undefined,
  positional?: { pageNumber?: string; description?: string }
): { pageNumber: string; description: string } {
  // 0. Positional detection — strongest signal when available. Falls through
  //    to the legacy heuristics when a field is blank so we can still fill
  //    one field from filename/label even if the other came from layout.
  if (positional && (positional.pageNumber || positional.description)) {
    let pageNumber = positional.pageNumber || '';
    let description = positional.description || '';
    if (!pageNumber) {
      // Backfill from name/filename only.
      const fromName = suggestedName && !isDefaultName(suggestedName)
        ? findBestSheetNumber(suggestedName) : null;
      const fromFile = !fromName
        ? findBestSheetNumber(filename.replace(/\.[^.]+$/, '').replace(/_+/g, ' '))
        : null;
      pageNumber = fromName || fromFile || '';
    }
    if (!description) {
      if (suggestedName && !isDefaultName(suggestedName)) {
        description = pageNumber ? stripNum(suggestedName, pageNumber) : suggestedName;
      }
    }
    return { pageNumber, description };
  }

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

export interface LoadPdfPagesOptions {
  /** When true, also rasterize each page to a JPEG dataUrl (legacy path). Defaults to false. */
  includeFullPageRaster?: boolean;
  /** When true, also produce a ~1600px `aiImageDataUrl` per page for local AI
   *  sheet reading. Defaults to false (skips the extra render when AI is off). */
  includeAiImage?: boolean;
}

export const loadPdfPagesGenerator = async function*(
  file: File,
  onProgress?: (status: string, pageNum: number, totalPages: number) => void,
  pageNums?: number[],
  options: LoadPdfPagesOptions = {}
): AsyncGenerator<PdfPageImage, void, unknown> {
  const includeFullPageRaster = options.includeFullPageRaster ?? false;
  const includeAiImage = options.includeAiImage ?? false;
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

    // Base viewport at 2.0× — this is the coordinate space measurements are stored
    // in (matches the legacy raster dimensions exactly), so a page's width / height
    // stay stable whether the consumer asks for the raster or not.
    const scale = 2.0;
    const viewport = page.getViewport({ scale });

    // Text extraction runs without rasterizing. For text-based PDFs this is the
    // accurate path; for image-based PDFs we still need OCR, which requires a
    // canvas — so render at thumbnail resolution in that case (the OCR canvas is
    // discarded after recognition).
    if (onProgress) onProgress('reading the text', i, totalPages);
    let extractedText = '';
    let detectedPageNumber = '';
    let detectedDescription = '';
    // High when the embedded (vector) text yielded a clean sheet number via
    // positional analysis below; stays low if we fall back to OCR / filename /
    // label heuristics. Captured here (before the OCR fallback overwrites
    // extractedText) so Task 7's review UI can flag uncertain rows.
    let detectionConfidence: ExtractConfidence = 'low';
    try {
      const textContent = await page.getTextContent();
      extractedText = textContent.items.map((item: any) => item.str).join(' ');
      // Positional auto-detection runs only on the vector path — OCR'd pages
      // don't carry per-glyph bounding boxes from Tesseract through this
      // pipeline, so they fall back to the legacy filename/label heuristics.
      try {
        const positioned = getPositionedText(textContent, viewport);
        detectedPageNumber = detectSheetNumberFromItems(positioned, viewport.width, viewport.height);
        detectedDescription = detectDescriptionFromItems(positioned, viewport.width, viewport.height, detectedPageNumber);
        // Embedded text produced a clean sheet number → trust this detection.
        if (detectedPageNumber) detectionConfidence = 'high';
      } catch (e) {
        console.warn('Positional page-info detection failed', e);
      }
    } catch (e) {
      console.warn('Could not extract text from page', e);
    }

    const needsOcr = !extractedText || extractedText.trim().length < 5;
    const needsFullRender = includeFullPageRaster || needsOcr;

    if (needsFullRender) {
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, intent: 'print' } as any).promise;
    }

    if (needsOcr) {
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

    // Thumbnail is always produced — needed for the page list UI.
    const thumbScale = 400 / Math.max(viewport.width, viewport.height);
    thumbCanvas.width = viewport.width * thumbScale;
    thumbCanvas.height = viewport.height * thumbScale;
    if (needsFullRender) {
      thumbCtx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    } else {
      // Render the page once directly at thumbnail resolution.
      const thumbVp = page.getViewport({ scale: scale * thumbScale });
      thumbCtx.fillStyle = 'white';
      thumbCtx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
      await page.render({ canvasContext: thumbCtx, viewport: thumbVp, intent: 'print' } as any).promise;
    }

    const dataUrl = includeFullPageRaster ? canvas.toDataURL('image/jpeg', 0.6) : '';
    const thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.5);

    // Medium-res image for local AI reading (the 400px thumbnail can't resolve a
    // title block). Rendered directly at AI scale for vector pages, or downscaled
    // from the already-rendered full canvas when we have one.
    let aiImageDataUrl = '';
    if (includeAiImage) {
      const aiScale = Math.min(1, 1600 / Math.max(viewport.width, viewport.height));
      const aiCanvas = document.createElement('canvas');
      aiCanvas.width = Math.round(viewport.width * aiScale);
      aiCanvas.height = Math.round(viewport.height * aiScale);
      const aiCtx = aiCanvas.getContext('2d');
      if (aiCtx) {
        aiCtx.fillStyle = 'white';
        aiCtx.fillRect(0, 0, aiCanvas.width, aiCanvas.height);
        if (needsFullRender) {
          aiCtx.drawImage(canvas, 0, 0, aiCanvas.width, aiCanvas.height);
        } else {
          const aiVp = page.getViewport({ scale: scale * aiScale });
          await page.render({ canvasContext: aiCtx, viewport: aiVp, intent: 'print' } as any).promise;
        }
        aiImageDataUrl = aiCanvas.toDataURL('image/jpeg', 0.72);
      }
    }

    page.cleanup();

    return {
      dataUrl,
      thumbnailDataUrl,
      aiImageDataUrl,
      width: viewport.width,
      height: viewport.height,
      pageNum: i,
      suggestedName,
      extractedText,
      detectedPageNumber,
      detectedDescription,
      detectionConfidence,
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
