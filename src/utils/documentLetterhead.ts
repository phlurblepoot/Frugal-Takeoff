import { jsPDF } from 'jspdf';

// ---------------------------------------------------------------------------
// Shared branded letterhead (header + footer) for generated documents.
//
// Reproduces Nathan's branded template (docs/Template.pdf):
//   - HEADER: a short BRAND-GREEN band at the top-left, an angled diagonal
//     transition, then a tall BLACK band filling the top-right. The company
//     contact block sits in white inside the black band, with the logo at the
//     top-right (white-on-dark). A thin brand-green rule spans the full width
//     just below the band.
//   - FOOTER: mirrored decorative angled GREEN + BLACK banners at the bottom
//     (no text).
//
// Geometry is built with jsPDF vector ops (Letter portrait, 612x792 pt) so it
// scales/prints crisply and needs no embedded raster background. The template's
// own banners are a 300-DPI background image; these coordinates approximate that
// look (clearly evocative, not pixel-perfect).
// ---------------------------------------------------------------------------

/** Brand green (lime) from the template — used as the colour fallback. */
export const BRAND_GREEN: [number, number, number] = [153, 203, 56]; // #99CB38

/**
 * Parse a CSS-ish hex colour (#rgb / #rrggbb, with or without the leading '#')
 * into an [r, g, b] triple (0..255). Invalid/empty input falls back to the
 * brand green so documents always get a sensible accent.
 */
export function hexToRgb(hex: string): [number, number, number] {
  if (typeof hex !== 'string') return [...BRAND_GREEN];
  let s = hex.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) {
    s = s
      .split('')
      .map(ch => ch + ch)
      .join('');
  }
  if (s.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(s)) return [...BRAND_GREEN];
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

/**
 * Invert an image (data URL) so a dark logo shows white on the black banner.
 * Loads the image onto a canvas, applies an `invert(1)` filter, and returns a
 * PNG data URL. On ANY failure (no DOM/canvas, load error, tainted canvas) the
 * original data URL is returned unchanged.
 */
export async function invertImageDataUrl(dataUrl: string): Promise<string> {
  try {
    if (typeof document === 'undefined' || !dataUrl) return dataUrl;

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image load failed'));
      el.src = dataUrl;
    });

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return dataUrl;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;

    // Prefer the cheap GPU filter path; fall back to per-pixel inversion.
    const supportsFilter = typeof ctx.filter === 'string';
    if (supportsFilter) {
      ctx.filter = 'invert(1)';
      ctx.drawImage(img, 0, 0, w, h);
    } else {
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i];
        d[i + 1] = 255 - d[i + 1];
        d[i + 2] = 255 - d[i + 2];
      }
      ctx.putImageData(data, 0, 0);
    }

    return canvas.toDataURL('image/png');
  } catch {
    return dataUrl;
  }
}

export interface LetterheadContext {
  /** Brand accent colour (RGB 0..255) — drives the green bands/rule. */
  brandRgb: [number, number, number];
  /** Company contact block; blank fields are skipped. */
  company: { name?: string; phone?: string; email?: string; address?: string };
  /** Optional logo (PNG/JPEG data URL); caller pre-inverts when configured. */
  logoDataUrl?: string;
}

// --- Letterhead geometry (Letter portrait, pt) ---------------------------------
const PAGE_W = 612;
const PAGE_H = 792;

// Header band heights / angle.
const HDR_GREEN_H = 38; // short green band at top-left
const HDR_BLACK_H = 84; // tall black band (top-right, full width minus the green wedge)
const HDR_ANGLE = 60; // horizontal run of the diagonal transitions
const HDR_GREEN_RIGHT = 196; // where the green band ends (top edge of its diagonal)
const HDR_RULE_GAP = 6; // gap between black band and the green rule
const HDR_RULE_H = 3; // green rule thickness

// Footer band heights / angle (mirrored, decorative).
const FTR_GREEN_H = 46;
const FTR_BLACK_H = 30;
const FTR_ANGLE = 60;
const FTR_GREEN_RIGHT = 300; // green spans ~left half before the diagonal

/**
 * Draw the branded header on the CURRENT page. Returns the contentTop Y where
 * body content may begin (a few pt below the green rule).
 */
export function drawLetterheadHeader(doc: jsPDF, ctx: LetterheadContext): number {
  const [gr, gg, gb] = ctx.brandRgb;

  // --- Black band: a full-width-right rectangle plus an angled left wedge. ---
  doc.setFillColor(0, 0, 0);
  // Main black rectangle covering the right portion at full header height.
  doc.rect(HDR_GREEN_RIGHT, 0, PAGE_W - HDR_GREEN_RIGHT, HDR_BLACK_H, 'F');
  // Angled left edge of the black band (diagonal sloping down-right):
  // wedge from the band's top-left up to the green band's lower-right.
  doc.triangle(
    HDR_GREEN_RIGHT, 0,
    HDR_GREEN_RIGHT, HDR_BLACK_H,
    HDR_GREEN_RIGHT - HDR_ANGLE, HDR_BLACK_H,
    'F',
  );

  // --- Green band (top-left), with a parallel angled right edge. ---
  doc.setFillColor(gr, gg, gb);
  doc.rect(0, 0, HDR_GREEN_RIGHT - HDR_ANGLE, HDR_GREEN_H, 'F');
  // Green's angled tip slots into the black wedge.
  doc.triangle(
    HDR_GREEN_RIGHT - HDR_ANGLE, 0,
    HDR_GREEN_RIGHT, 0,
    HDR_GREEN_RIGHT - HDR_ANGLE, HDR_GREEN_H,
    'F',
  );

  // --- Company contact block (white) inside the black band, right of centre. ---
  const c = ctx.company || {};
  const textRight = PAGE_W - 120; // leave room for the logo at the far right
  let ty = 24;
  if (c.name) {
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(255, 255, 255);
    doc.text(String(c.name), textRight, ty, { align: 'right' });
    ty += 14;
  }
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(235, 235, 235);
  for (const line of [c.phone, c.address, c.email].filter(Boolean)) {
    doc.text(String(line), textRight, ty, { align: 'right' });
    ty += 12;
  }

  // --- Logo at the top-right (fit a ~64pt-tall box, ~609x456 aspect). ---
  if (ctx.logoDataUrl) {
    try {
      const boxH = 60;
      const boxW = boxH * (609 / 456); // ~80pt wide
      const lx = PAGE_W - 24 - boxW;
      const ly = (HDR_BLACK_H - boxH) / 2;
      doc.addImage(ctx.logoDataUrl, 'PNG', lx, ly, boxW, boxH);
    } catch {
      /* skip missing/bad logo */
    }
  }

  // --- Thin brand-green rule spanning the full width below the band. ---
  const ruleY = HDR_BLACK_H + HDR_RULE_GAP;
  doc.setFillColor(gr, gg, gb);
  doc.rect(0, ruleY, PAGE_W, HDR_RULE_H, 'F');

  return ruleY + HDR_RULE_H + 18; // contentTop
}

/**
 * Draw the mirrored decorative footer banners on the CURRENT page. Returns the
 * contentBottom Y (top of the footer) so callers keep body content above it.
 */
export function drawLetterheadFooter(doc: jsPDF, ctx: LetterheadContext): number {
  const [gr, gg, gb] = ctx.brandRgb;

  const greenTop = PAGE_H - FTR_GREEN_H;
  const blackTop = PAGE_H - FTR_BLACK_H;

  // --- Black band (bottom-right): rectangle + angled left wedge. ---
  doc.setFillColor(0, 0, 0);
  doc.rect(FTR_GREEN_RIGHT, blackTop, PAGE_W - FTR_GREEN_RIGHT, FTR_BLACK_H, 'F');
  doc.triangle(
    FTR_GREEN_RIGHT, blackTop,
    FTR_GREEN_RIGHT, PAGE_H,
    FTR_GREEN_RIGHT - FTR_ANGLE, PAGE_H,
    'F',
  );

  // --- Green band (bottom-left), taller, with a parallel angled right edge. ---
  doc.setFillColor(gr, gg, gb);
  doc.rect(0, greenTop, FTR_GREEN_RIGHT - FTR_ANGLE, FTR_GREEN_H, 'F');
  doc.triangle(
    FTR_GREEN_RIGHT - FTR_ANGLE, greenTop,
    FTR_GREEN_RIGHT, greenTop,
    FTR_GREEN_RIGHT - FTR_ANGLE, PAGE_H,
    'F',
  );

  return greenTop - 12; // contentBottom (keep body above this)
}
