import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

import { jsPDF } from 'jspdf';
import { Project, MeasurementTakeoff } from '../../../types';
import { getFile, getImage } from '../../../utils/store';
import {
  calculatePolylineLength,
  calculatePolygonArea,
  calculateRealValue,
  formatMeasurement,
  calculateSurfaceAreaPx,
  convertUnit,
  UNIT_LABELS,
  calculateTakeoffTotalCost,
  calculateTakeoffCostDetails,
  roundUpTo100,
  expandArcPoints,
} from '../../../utils/math';

// Converts a data URL (e.g. "data:application/pdf;base64,...") to a fresh Uint8Array.
export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Hex "#rrggbb" → 0-1 RGB components for pdf-lib's rgb(). Defaults gracefully.
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return { r: 0.231, g: 0.510, b: 0.965 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

// Builds the highlighted-plans PDF. For vector-source pages it copies the
// original PDF page (preserving all native vectors and text) and stamps
// measurements + legend on top as pdf-lib drawing primitives — output is
// fully vector, dramatically smaller and crisp at any zoom. Legacy pages
// without a sourcePdfFileId fall back to embedding the rasterized JPEG.
export async function buildHighlightsPdf(
  project: Project,
  selectedTakeoffIds: Set<string>,
  _quality: HighlightQuality = 'standard',
  onProgress?: (msg: string) => void,
  currentPageIds?: Set<string>,
): Promise<ArrayBuffer | null> {
  // Only print the current revision of each sheet; superseded pages with
  // leftover measurements are excluded so printouts match the takeoff totals.
  const pagesToPrint = project.pages.filter(page =>
    page.measurements.some(m => selectedTakeoffIds.has(m.takeoffId || '')) &&
    (!currentPageIds || currentPageIds.has(page.id))
  );
  if (pagesToPrint.length === 0) return null;

  const { PDFDocument, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = await import('pdf-lib');

  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  // Cache source PDFs so multi-page documents only round-trip once.
  const sourceDocs = new Map<string, any>();
  const loadSourceDoc = async (fileId: string): Promise<any | null> => {
    if (sourceDocs.has(fileId)) return sourceDocs.get(fileId);
    try {
      const dataUrl = await getFile(fileId);
      if (!dataUrl) return null;
      const bytes = dataUrlToUint8Array(dataUrl);
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      sourceDocs.set(fileId, doc);
      return doc;
    } catch (e) {
      console.warn('Failed to load source PDF', fileId, e);
      sourceDocs.set(fileId, null);
      return null;
    }
  };

  for (let i = 0; i < pagesToPrint.length; i++) {
    onProgress?.(`Adding page ${i + 1} of ${pagesToPrint.length}…`);
    const page = pagesToPrint[i];

    // Build the destination page. Two paths:
    //   • Vector: copy the original PDF page so its native content (text,
    //     vectors, embedded images) survives. The measurements layer needs to
    //     scale from the project's 2.0× coord space down to PDF points (×0.5).
    //   • Legacy: a blank page sized to the stored raster dimensions, with
    //     that raster embedded as a full-page JPEG. Measurements are drawn
    //     in their native 1:1 coord space.
    let outPage: any = null;
    let scaleFactor = 1.0;
    let pageWidth = page.imageWidth;
    let pageHeight = page.imageHeight;
    let rotation = 0;

    if (page.sourcePdfFileId && page.sourcePdfPageNum) {
      const srcDoc = await loadSourceDoc(page.sourcePdfFileId);
      if (srcDoc) {
        try {
          const idx = page.sourcePdfPageNum - 1;
          if (idx >= 0 && idx < srcDoc.getPageCount()) {
            const [copied] = await outDoc.copyPages(srcDoc, [idx]);
            outDoc.addPage(copied);
            outPage = copied;
            rotation = copied.getRotation().angle;
            pageWidth = copied.getWidth();
            pageHeight = copied.getHeight();
            scaleFactor = 0.5; // imageWidth = 2.0 × natural PDF points
          }
        } catch (e) {
          console.warn(`Failed to copy source page ${page.sourcePdfPageNum} of ${page.sourcePdfFileId}`, e);
        }
      }
    }

    if (!outPage) {
      // Legacy raster fallback.
      pageWidth = page.imageWidth;
      pageHeight = page.imageHeight;
      scaleFactor = 1.0;
      outPage = outDoc.addPage([pageWidth, pageHeight]);
      if (page.imageId) {
        try {
          const dataUrl = await getImage(page.imageId);
          if (dataUrl) {
            const imgBytes = dataUrlToUint8Array(dataUrl);
            const isPng = dataUrl.startsWith('data:image/png');
            const embedded = isPng ? await outDoc.embedPng(imgBytes) : await outDoc.embedJpg(imgBytes);
            outPage.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
          }
        } catch (e) {
          console.warn('Failed to embed legacy page image', e);
        }
      }
    }

    // Measurements are captured on the *displayed* page — pdf.js rasterizes the
    // canvas via getViewport({ scale: 2.0 }), which honours /Rotate, so the
    // coords live in the rotated, viewer-facing image space. The page we copied,
    // however, exposes its *unrotated* content box (getWidth/getHeight ignore
    // /Rotate). So we compose the overlay in displayed space and concat a
    // transform matrix that maps it into the page's unrotated content space;
    // the viewer's /Rotate then renders both the page and our marks together.
    const rot = ((rotation % 360) + 360) % 360;
    const swapsAxes = rot === 90 || rot === 270;
    const dispH = swapsAxes ? pageWidth : pageHeight; // displayed (viewer) height in PDF points

    // Maps a displayed-space point (Y-up) to unrotated content space.
    let rotationMatrix: [number, number, number, number, number, number] | null = null;
    if (rot === 90) rotationMatrix = [0, 1, -1, 0, pageWidth, 0];
    else if (rot === 180) rotationMatrix = [-1, 0, 0, -1, pageWidth, pageHeight];
    else if (rot === 270) rotationMatrix = [0, -1, 1, 0, 0, pageHeight];
    if (rotationMatrix) {
      outPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(...rotationMatrix));
    }

    // ── Vector overlay: measurements ────────────────────────────────────────
    // SVG path origin is top-left with Y-down (pdf-lib flips to PDF Y-up when
    // drawn at y=dispH). All measurement coords are scaled into PDF points
    // first so the drawSvgPath origin maps cleanly.
    const sf = scaleFactor;
    const pdfX = (mx: number) => mx * sf;
    const pdfY = (my: number) => dispH - my * sf; // for non-SVG primitives (Y-up)

    for (const m of page.measurements) {
      if (!selectedTakeoffIds.has(m.takeoffId || '')) continue;
      if (!m.points || m.points.length === 0) continue;
      const takeoff = project.takeoffs.find(t => t.id === m.takeoffId);
      const colorHex = takeoff?.color || m.color || '#3b82f6';
      const c = hexToRgb(colorHex);
      const stroke = m.type === 'length' ? 8 * sf : 3 * sf;

      if (m.type === 'count') {
        const p = m.points[0];
        const cx = pdfX(p.x);
        const cy = pdfY(p.y);
        outPage.drawCircle({
          x: cx, y: cy,
          size: 12 * sf,
          color: rgb(c.r, c.g, c.b),
          opacity: 0.25,
          borderColor: rgb(c.r, c.g, c.b),
          borderWidth: stroke,
        });
        // White cross on top.
        const armCss = 6 * sf;
        outPage.drawLine({
          start: { x: cx - armCss, y: cy }, end: { x: cx + armCss, y: cy },
          thickness: 2 * sf, color: rgb(1, 1, 1),
        });
        outPage.drawLine({
          start: { x: cx, y: cy - armCss }, end: { x: cx, y: cy + armCss },
          thickness: 2 * sf, color: rgb(1, 1, 1),
        });
        continue;
      }

      // Polyline / polygon for length & area, with arcs expanded.
      const allSegs: { points: typeof m.points; arcMidIndices?: number[] }[] = [
        { points: m.points, arcMidIndices: m.arcMidIndices },
        ...(m.segments ?? []),
      ];
      for (const seg of allSegs) {
        if (!seg.points || seg.points.length === 0) continue;
        const dispPts = expandArcPoints(seg.points, seg.arcMidIndices);
        if (dispPts.length < 2) continue;
        const cmds: string[] = [`M ${dispPts[0].x * sf} ${dispPts[0].y * sf}`];
        for (let j = 1; j < dispPts.length; j++) cmds.push(`L ${dispPts[j].x * sf} ${dispPts[j].y * sf}`);
        if (m.type === 'area') cmds.push('Z');
        const path = cmds.join(' ');
        outPage.drawSvgPath(path, {
          x: 0, y: dispH,
          borderColor: rgb(c.r, c.g, c.b),
          borderWidth: stroke,
          color: m.type === 'area' ? rgb(c.r, c.g, c.b) : undefined,
          opacity: m.type === 'area' ? 0.25 : undefined,
        });
      }

      // Label centered on the primary segment.
      let centerX = 0, centerY = 0;
      if (m.type === 'length') {
        const midIdx = Math.floor((m.points.length - 1) / 2);
        centerX = (m.points[midIdx].x + m.points[midIdx + 1].x) / 2;
        centerY = (m.points[midIdx].y + m.points[midIdx + 1].y) / 2;
      } else {
        m.points.forEach(p => { centerX += p.x; centerY += p.y; });
        centerX /= m.points.length;
        centerY /= m.points.length;
      }
      const isSurfaceArea = takeoff?.type === 'area' && m.type === 'length';
      const allSegPts = [m.points, ...(m.segments ?? []).map(s => s.points)];
      let text = '';
      if (isSurfaceArea) text = formatMeasurement(allSegPts.reduce((sum, pts) => sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, page.scaleConfig), 0), 'area', page.scaleConfig, takeoff);
      else if (m.type === 'length') text = formatMeasurement(allSegPts.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0), 'length', page.scaleConfig, takeoff);
      else text = formatMeasurement(allSegPts.reduce((sum, pts) => sum + calculatePolygonArea(pts), 0), 'area', page.scaleConfig, takeoff);

      if (text) {
        const fontSize = 14 * sf;
        const textWidth = font.widthOfTextAtSize(text, fontSize);
        const bgX = pdfX(centerX) - textWidth / 2 - 4 * sf;
        const bgY = pdfY(centerY) - fontSize * 0.7;
        outPage.drawRectangle({
          x: bgX, y: bgY,
          width: textWidth + 8 * sf,
          height: fontSize * 1.4,
          color: rgb(1, 1, 1),
          opacity: 0.8,
        });
        outPage.drawText(text, {
          x: pdfX(centerX) - textWidth / 2,
          y: pdfY(centerY) - fontSize * 0.3,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }

    // ── Vector overlay: legend ──────────────────────────────────────────────
    if ((page.showLegend ?? project.legendOnAllPages) && project.takeoffs.length > 0) {
      const legendItems: { color: string; name: string; total: string }[] = [];
      for (const takeoff of project.takeoffs) {
        let totalRealValue = 0;
        let hasMeasurements = false;
        for (const m of page.measurements.filter(m => m.takeoffId === takeoff.id)) {
          if (!selectedTakeoffIds.has(m.takeoffId || '')) continue;
          hasMeasurements = true;
          let currentScale = page.scaleConfig;
          if (page.isMultiRegion && m.regionId) {
            const region = page.scaleRegions?.find(r => r.id === m.regionId);
            if (region?.scaleConfig) currentScale = region.scaleConfig;
          }
          const allMPts = [m.points, ...(m.segments ?? []).map(s => s.points)];
          let pixelValue = 0;
          if (takeoff.type === 'length' && m.type === 'length') pixelValue = allMPts.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
          else if (takeoff.type === 'area' && m.type === 'area') pixelValue = allMPts.reduce((sum, pts) => sum + calculatePolygonArea(pts), 0);
          else if (takeoff.type === 'area' && m.type === 'length') pixelValue = allMPts.reduce((sum, pts) => sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, currentScale), 0);
          else if (takeoff.type === 'count' && m.type === 'count') pixelValue = 1;
          if (pixelValue > 0) {
            const realValue = calculateRealValue(pixelValue, takeoff.type as 'length' | 'area' | 'count', currentScale);
            const targetUnit = takeoff.unit || page.scaleConfig?.unit || 'ft';
            const sourceUnit = currentScale?.unit || 'ft';
            if (takeoff.type === 'count') totalRealValue += realValue;
            else totalRealValue += convertUnit(realValue, sourceUnit, targetUnit.replace('sq ', ''), takeoff.type as 'length' | 'area' | 'count');
          }
        }
        if (hasMeasurements) {
          const targetUnit = takeoff.unit || page.scaleConfig?.unit || 'ft';
          const unitLabel = ` ${UNIT_LABELS[takeoff.type as keyof typeof UNIT_LABELS]?.[targetUnit] || targetUnit}`;
          const formattedTotal = takeoff.type === 'count' ? Math.round(totalRealValue).toString() : totalRealValue.toFixed(2);
          legendItems.push({ color: takeoff.color, name: takeoff.name, total: page.showLegendTotals !== false ? `${formattedTotal}${unitLabel}` : '' });
        }
      }

      if (legendItems.length > 0) {
        const fontSize = (page.legendFontSize || 24) * sf;
        const padding = fontSize * 0.9;
        const itemHeight = fontSize * 1.7;
        const colorBoxSize = fontSize;
        const textOffsetX = colorBoxSize + Math.round(fontSize * 0.5);
        const width = (page.legendWidth || 500) * sf;
        const headerH = padding * 2 + fontSize * 1.4;
        const height = headerH + legendItems.length * itemHeight + padding;
        const pos = page.legendPosition || { x: 20, y: 20 };
        const legendX = pdfX(pos.x);
        const legendTopY = pdfY(pos.y); // PDF y of the top edge of the legend card

        // Card background + 1px border (no rounded corners — pdf-lib's drawRectangle
        // doesn't support radii, and the rest of the printout already uses sharp
        // rectangles for measurement labels).
        outPage.drawRectangle({
          x: legendX, y: legendTopY - height,
          width, height,
          color: rgb(1, 1, 1),
          borderColor: rgb(0.792, 0.835, 0.882), // #cbd5e1
          borderWidth: 1 * sf,
        });
        // Header band.
        outPage.drawRectangle({
          x: legendX, y: legendTopY - headerH,
          width, height: headerH,
          color: rgb(0.945, 0.961, 0.976), // #f1f5f9
        });
        // Header text.
        outPage.drawText('Legend', {
          x: legendX + padding,
          y: legendTopY - padding * 0.8 - (fontSize + 2),
          size: fontSize + 2,
          font: fontBold,
          color: rgb(0.118, 0.161, 0.231), // #1e293b
        });

        legendItems.forEach((item, index) => {
          const rowTop = legendTopY - (headerH + padding * 0.5 + index * itemHeight);
          const boxBottom = rowTop - itemHeight + (itemHeight - colorBoxSize) / 2;
          const textBaseline = rowTop - itemHeight + (itemHeight - fontSize) / 2;

          // Color swatch.
          const swatch = hexToRgb(item.color);
          outPage.drawRectangle({
            x: legendX + padding, y: boxBottom,
            width: colorBoxSize, height: colorBoxSize,
            color: rgb(swatch.r, swatch.g, swatch.b),
          });

          // Name — truncate with "…" if it would overlap the totals column.
          const maxNameWidth = width - padding * 2 - textOffsetX - (page.showLegendTotals !== false ? fontSize * 8 : 0);
          let nameText = item.name;
          while (nameText.length > 0 && font.widthOfTextAtSize(nameText + '...', fontSize) > maxNameWidth) {
            nameText = nameText.slice(0, -1);
          }
          if (nameText.length < item.name.length) nameText += '...';

          outPage.drawText(nameText, {
            x: legendX + padding + textOffsetX,
            y: textBaseline,
            size: fontSize,
            font,
            color: rgb(0.2, 0.255, 0.333), // #334155
          });

          if (page.showLegendTotals !== false && item.total) {
            const totalWidth = fontBold.widthOfTextAtSize(item.total, fontSize);
            outPage.drawText(item.total, {
              x: legendX + width - padding - totalWidth,
              y: textBaseline,
              size: fontSize,
              font: fontBold,
              color: rgb(0.059, 0.090, 0.165), // #0f172a
            });
          }
        });

        // `degrees` is imported above but only needed if we ever stamp rotated
        // text; silence the unused-variable warning by referencing it once.
        void degrees;
      }
    }

    // Balance the graphics-state push from the rotation transform above.
    if (rotationMatrix) {
      outPage.pushOperators(popGraphicsState());
    }
  }

  const out = await outDoc.save();
  // pdf-lib returns a Uint8Array; turn it into an ArrayBuffer for the existing
  // saveFile path.
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

// ── Highlight quality presets ────────────────────────────────────────────────
export const HIGHLIGHT_QUALITY_PRESETS = {
  full:     { label: 'Full Resolution',              maxDim: Infinity, jpegQuality: 0.90 },
  large:    { label: 'Large  (≈A2 — high quality)',  maxDim: 1680,     jpegQuality: 0.85 },
  standard: { label: 'Standard  (≈A3)',              maxDim: 1190,     jpegQuality: 0.80 },
  compact:  { label: 'Compact  (near A4)',            maxDim: 680,      jpegQuality: 0.72 },
} as const;
export type HighlightQuality = keyof typeof HIGHLIGHT_QUALITY_PRESETS;

// ── Per-user localStorage key for proposal preferences ───────────────────────
export function getProposalPrefsKey(): string {
  try {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    return `proposal-prefs-${user.id || 'default'}`;
  } catch {
    return 'proposal-prefs-default';
  }
}

// Per-takeoff totals as produced by ProjectView's getTakeoffTotals(): the base
// takeoff augmented with computed totals + per-page breakdown.
export type TakeoffTotals = MeasurementTakeoff & {
  totalRealValue: number;
  unit: string;
  pageBreakdown: {
    pageId: string;
    pageName: string;
    realValue: number;
    unit: string;
    measurements: { id: string; name: string; realValue: number; unit: string }[];
  }[];
};

// Pure per-takeoff totals computation. Extracted verbatim from ProjectView's
// getTakeoffTotals() so both the legacy modal and the new /proposal section
// share ONE implementation. Only the current revision of each sheet counts —
// the caller passes `currentPageIds` (from computeRevisionModel) so that
// measurements stranded on superseded sheets don't inflate the totals.
export function computeTakeoffTotals(
  project: Project,
  currentPageIds: Set<string>,
): TakeoffTotals[] {
  const pagesToCalculate = project.pages.filter(p => currentPageIds.has(p.id));

  return project.takeoffs.map(takeoff => {
    let totalRealValue = 0;
    let displayUnit = takeoff.unit || '';

    const pageBreakdown: { pageId: string; pageName: string; realValue: number; unit: string; measurements: { id: string; name: string; realValue: number; unit: string }[] }[] = [];

    pagesToCalculate.forEach(page => {
      const takeoffMeasurements = page.measurements.filter(m => m.takeoffId === takeoff.id);

      if (takeoffMeasurements.length > 0) {
        let pageRealValue = 0;
        let pageUnit = '';
        const measurementBreakdown: { id: string; name: string; realValue: number; unit: string }[] = [];

        takeoffMeasurements.forEach(m => {
          // Determine which scale to use
          let currentScale = page.scaleConfig;
          if (page.isMultiRegion && m.regionId) {
            const region = page.scaleRegions?.find(r => r.id === m.regionId);
            if (region?.scaleConfig) {
              currentScale = region.scaleConfig;
            }
          }

          let measurementRealValue = 0;
          let measurementUnit = '';

          if (takeoff.type === 'count') {
            measurementRealValue = 1;
            measurementUnit = 'each';
          } else if (currentScale) {
            const allMPtsTotals = [m.points, ...(m.segments ?? []).map(s => s.points)];
            let pixelValue = 0;
            if (takeoff.type === 'length' && m.type === 'length') {
              pixelValue = allMPtsTotals.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
            } else if (takeoff.type === 'area' && m.type === 'area') {
              pixelValue = allMPtsTotals.reduce((sum, pts) => sum + calculatePolygonArea(pts), 0);
            } else if (takeoff.type === 'area' && m.type === 'length') {
              pixelValue = allMPtsTotals.reduce((sum, pts) => sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, currentScale), 0);
            }

            if (pixelValue > 0) {
              const realVal = calculateRealValue(pixelValue, takeoff.type as 'length' | 'area' | 'count', currentScale);

              // Convert to a consistent unit
              // If takeoff has a specific unit, use that. Otherwise use page scale unit.
              const targetUnit = takeoff.unit || page.scaleConfig?.unit || currentScale.unit;
              const convertedVal = convertUnit(realVal, currentScale.unit, targetUnit.replace('sq ', ''), takeoff.type as 'length' | 'area' | 'count');

              measurementRealValue = convertedVal;
              measurementUnit = targetUnit.startsWith('sq ') ? targetUnit : (takeoff.type === 'area' && !targetUnit.startsWith('sq ') ? `sq ${targetUnit}` : targetUnit);
            }
          }

          if (measurementRealValue > 0) {
            pageRealValue += measurementRealValue;
            pageUnit = measurementUnit;
            measurementBreakdown.push({
              id: m.id,
              name: m.name,
              realValue: measurementRealValue,
              unit: measurementUnit,
            });
          }
        });

        if (pageRealValue > 0) {
          totalRealValue += pageRealValue;
          if (!displayUnit) displayUnit = pageUnit;

          pageBreakdown.push({
            pageId: page.id,
            pageName: page.name,
            realValue: pageRealValue,
            unit: pageUnit,
            measurements: measurementBreakdown,
          });
        }
      }
    });

    return {
      ...takeoff,
      totalRealValue,
      unit: takeoff.unit || displayUnit, // Keep the original unit if it was set, otherwise use the detected one
      pageBreakdown,
    };
  });
}

export interface ProposalOptions {
  includeCostDetail: boolean; includeHighlights: boolean;
  headerColor: string; coverNotes: string;
  fontFamily: 'helvetica' | 'times' | 'courier';
  validUntil: string; terms: string;
  includeSignature: boolean; includeTakeoffList: boolean;
  customTitle: string; highlightQuality: HighlightQuality;
}

export interface ProposalGenResult { pdfBytes: ArrayBuffer; suggestedName: string; }

export const formatCurrency = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function generateProposalPdf(
  project: Project,
  takeoffTotals: TakeoffTotals[],
  selectedTakeoffIds: Set<string>,
  currentPageIds: Set<string>,
  options: ProposalOptions,
  settings: Record<string, string>,
  onProgress?: (msg: string) => void,
): Promise<ProposalGenResult> {
  const {
    includeCostDetail,
    includeHighlights,
    headerColor,
    coverNotes,
    fontFamily,
    validUntil,
    terms,
    includeSignature,
    includeTakeoffList,
    customTitle: proposalCustomTitle,
    highlightQuality,
  } = options;

  const selectedTakeoffs = takeoffTotals.filter(t => selectedTakeoffIds.has(t.id));

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();

  // Derive header RGB + a lighter accent tint (60% header + 40% white)
  const hexToRgb = (hex: string): [number, number, number] => {
    const c = hex.replace('#', '');
    const full = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
    return [parseInt(full.slice(0,2),16), parseInt(full.slice(2,4),16), parseInt(full.slice(4,6),16)];
  };
  const [hR, hG, hB] = hexToRgb(headerColor);
  const accentR = Math.round(hR + (255-hR)*0.4);
  const accentG = Math.round(hG + (255-hG)*0.4);
  const accentB = Math.round(hB + (255-hB)*0.4);
  const font = fontFamily;

  // ── COVER PAGE ──────────────────────────────────────────────────────
  // Header band
  pdf.setFillColor(hR, hG, hB);
  pdf.rect(0, 0, W, 120, 'F');

  // Logo
  let logoLoaded = false;
  if (settings.logoUrl) {
    try {
      const logoImg = new Image();
      logoImg.crossOrigin = 'anonymous';
      logoImg.src = settings.logoUrl;
      await new Promise<void>(r => { logoImg.onload = () => r(); logoImg.onerror = () => r(); });
      if (logoImg.complete && logoImg.naturalWidth > 0) {
        pdf.addImage(logoImg, 40, 18, 84, 84);
        logoLoaded = true;
      }
    } catch { /* skip */ }
  }

  const textX = logoLoaded ? 144 : 40;
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(15);
  pdf.setFont(font, 'bold');
  pdf.text(settings.companyName || settings.appName || 'Proposal', textX, 52);

  const contactParts = [settings.companyPhone, settings.companyEmail, settings.companyAddress].filter(Boolean);
  if (contactParts.length > 0) {
    pdf.setFontSize(9);
    pdf.setFont(font, 'normal');
    pdf.text(contactParts.join('   ·   '), textX, 72);
  }

  // "PROPOSAL" heading — 38pt with branded accent bar
  pdf.setTextColor(hR, hG, hB);
  pdf.setFontSize(38);
  pdf.setFont(font, 'bold');
  pdf.text('PROPOSAL', W / 2, 210, { align: 'center' });
  // Short bold accent bar
  pdf.setFillColor(hR, hG, hB);
  pdf.rect(W / 2 - 50, 220, 100, 3, 'F');
  // Thin tinted full-width rule
  pdf.setDrawColor(accentR, accentG, accentB);
  pdf.setLineWidth(0.5);
  pdf.line(40, 230, W - 40, 230);

  // Project name
  const title = proposalCustomTitle || project.name;
  pdf.setFontSize(22);
  pdf.setFont(font, 'bold');
  pdf.setTextColor(15, 23, 42);
  const titleLines = pdf.splitTextToSize(title, W - 80) as string[];
  pdf.text(titleLines, W / 2, 265, { align: 'center' });
  let coverY = 265 + titleLines.length * 28;

  if (project.address) {
    pdf.setFontSize(12);
    pdf.setFont(font, 'normal');
    pdf.setTextColor(71, 85, 105);
    pdf.text(project.address, W / 2, coverY + 10, { align: 'center' });
    coverY += 30;
  }

  // ── COVER PAGE: notes (context) first, then grand total ─────────────
  const grandTotal = selectedTakeoffs.reduce(
    (sum, t) => sum + calculateTakeoffTotalCost(t, t.totalRealValue), 0
  );

  let boxTop: number;

  if (coverNotes.trim()) {
    // Notes box first — sets context for the reader
    const notesX = 60;
    const notesMaxW = W - 120;
    pdf.setFontSize(10);
    pdf.setFont(font, 'normal');
    const notesLines = pdf.splitTextToSize(coverNotes.trim(), notesMaxW - 20) as string[];
    const lineH = 15;
    const padV = 14;
    const notesBH = notesLines.length * lineH + padV * 2;
    const notesBoxTop = Math.max(coverY + 40, 380);

    pdf.setFillColor(248, 250, 252);
    pdf.setDrawColor(accentR, accentG, accentB);
    pdf.setLineWidth(0.75);
    pdf.roundedRect(notesX, notesBoxTop, notesMaxW, notesBH, 4, 4, 'FD');
    pdf.setFillColor(hR, hG, hB);
    pdf.rect(notesX, notesBoxTop, 3, notesBH, 'F');
    pdf.setTextColor(71, 85, 105);
    pdf.text(notesLines, notesX + 14, notesBoxTop + padV + 10);

    // Total box below notes
    boxTop = notesBoxTop + notesBH + 24;
  } else {
    boxTop = Math.max(coverY + 40, 400);
  }

  // Grand total box
  pdf.setFillColor(241, 245, 249);
  pdf.setDrawColor(accentR, accentG, accentB);
  pdf.setLineWidth(0.75);
  pdf.roundedRect(W / 2 - 115, boxTop, 230, 84, 8, 8, 'FD');
  pdf.setFillColor(hR, hG, hB);
  pdf.rect(W / 2 - 115, boxTop, 4, 84, 'F');
  pdf.setFontSize(9);
  pdf.setFont(font, 'bold');
  pdf.setTextColor(100, 116, 139);
  pdf.text('TOTAL PROPOSAL VALUE', W / 2, boxTop + 24, { align: 'center' });
  pdf.setFontSize(28);
  pdf.setFont(font, 'bold');
  pdf.setTextColor(15, 23, 42);
  pdf.text(formatCurrency(roundUpTo100(grandTotal)), W / 2, boxTop + 60, { align: 'center' });

  // Valid until
  if (validUntil) {
    const validY = boxTop + 100;
    pdf.setFontSize(9);
    pdf.setFont(font, 'italic');
    pdf.setTextColor(100, 116, 139);
    pdf.text(`This proposal is valid until ${new Date(validUntil + 'T00:00:00').toLocaleDateString()}.`, W / 2, Math.min(validY, H - 90), { align: 'center' });
  }

  // Signature block
  if (includeSignature) {
    const sigY = H - 130;
    pdf.setDrawColor(accentR, accentG, accentB);
    pdf.setLineWidth(0.5);
    // Authorized signature
    pdf.line(40, sigY, 220, sigY);
    pdf.setFontSize(8);
    pdf.setFont(font, 'normal');
    pdf.setTextColor(100, 116, 139);
    pdf.text('Authorized Signature', 40, sigY + 12);
    // Date
    pdf.line(260, sigY, 380, sigY);
    pdf.text('Date', 260, sigY + 12);
    // Printed name
    pdf.line(W / 2 + 20, sigY, W - 40, sigY);
    pdf.text('Printed Name', W / 2 + 20, sigY + 12);
    // "Accepted by" label above
    pdf.setFontSize(9);
    pdf.setFont(font, 'bold');
    pdf.setTextColor(hR, hG, hB);
    pdf.text('ACCEPTED BY', 40, sigY - 14);
  }

  // Cover page footer
  pdf.setFontSize(9);
  pdf.setTextColor(148, 163, 184);
  pdf.setFont(font, 'normal');
  pdf.text(`Prepared ${new Date().toLocaleDateString()}`, W / 2, H - 36, { align: 'center' });

  const projNameTrunc = project.name.length > 45 ? project.name.substring(0, 45) + '…' : project.name;

  // ── TAKEOFF SUMMARY PAGE ────────────────────────────────────────────
  if (includeTakeoffList) {
  onProgress?.('Adding scope details…');
  pdf.addPage();

  pdf.setFillColor(hR, hG, hB);
  pdf.rect(0, 0, W, 50, 'F');
  pdf.setFontSize(13);
  pdf.setFont(font, 'bold');
  pdf.setTextColor(255, 255, 255);
  pdf.text('Takeoff Summary', 40, 33);
  pdf.setFontSize(10);
  pdf.setFont(font, 'normal');
  pdf.text(projNameTrunc, W - 40, 33, { align: 'right' });

  // Table columns
  const COL = { swatch: 40, name: 62, type: 258, qty: 330, unit: 400, cost: W - 40 };
  const tableTop = 78;
  const rowH = 28;

  // Table header — bottom border line instead of fill
  pdf.setDrawColor(accentR, accentG, accentB);
  pdf.setLineWidth(0.5);
  pdf.line(40, tableTop - 1, W - 40, tableTop - 1);
  pdf.setFontSize(8);
  pdf.setFont(font, 'bold');
  pdf.setTextColor(hR, hG, hB);
  pdf.text('TAKEOFF', COL.name, tableTop - 4);
  pdf.text('TYPE', COL.type, tableTop - 4);
  pdf.text('QTY', COL.qty, tableTop - 4);
  pdf.text('UNIT', COL.unit, tableTop - 4);
  pdf.text('COST', COL.cost, tableTop - 4, { align: 'right' });

  let y = tableTop + 10;

  // Build grouped structure matching the project view
  const packageOrder: string[] = [];
  const packageMap: Record<string, typeof selectedTakeoffs> = {};
  const ungrouped: typeof selectedTakeoffs = [];
  for (const t of selectedTakeoffs) {
    if (t.pricePackage) {
      if (!packageMap[t.pricePackage]) {
        packageMap[t.pricePackage] = [];
        packageOrder.push(t.pricePackage);
      }
      packageMap[t.pricePackage].push(t);
    } else {
      ungrouped.push(t);
    }
  }

  // Helper: draw a single takeoff row (and optional cost-detail sub-rows)
  let rowIndex = 0;
  const drawTakeoffRow = (t: typeof selectedTakeoffs[0]) => {
    const totalCost = calculateTakeoffTotalCost(t, t.totalRealValue);
    const unitLabel = UNIT_LABELS[t.unit || ''] || t.unit ||
      (t.type === 'area' ? 'sq ft' : t.type === 'length' ? 'ft' : 'ea');

    // New page if near bottom
    if (y > H - 80) {
      pdf.addPage();
      pdf.setFillColor(hR, hG, hB);
      pdf.rect(0, 0, W, 50, 'F');
      pdf.setFontSize(13);
      pdf.setFont(font, 'bold');
      pdf.setTextColor(255, 255, 255);
      pdf.text('Takeoff Summary (cont.)', 40, 33);
      pdf.setFontSize(10);
      pdf.setFont(font, 'normal');
      pdf.text(projNameTrunc, W - 40, 33, { align: 'right' });
      y = 70;
      rowIndex = 0;
    }

    rowIndex++;

    // Color swatch
    const hex = (t.color || '#3b82f6').replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    pdf.setFillColor(r, g, b);
    pdf.roundedRect(COL.swatch, y - 9, 13, 13, 2, 2, 'F');

    // Name
    pdf.setFontSize(10);
    pdf.setFont(font, 'bold');
    pdf.setTextColor(15, 23, 42);
    const name = t.name.length > 28 ? t.name.substring(0, 27) + '…' : t.name;
    pdf.text(name, COL.name, y);

    // Type / Qty / Unit
    pdf.setFont(font, 'normal');
    pdf.setTextColor(71, 85, 105);
    pdf.text(t.type, COL.type, y);
    pdf.text(t.totalRealValue.toFixed(2), COL.qty, y);
    pdf.text(unitLabel, COL.unit, y);

    // Cost
    pdf.setFont(font, 'bold');
    pdf.setTextColor(15, 23, 42);
    pdf.text(formatCurrency(roundUpTo100(totalCost)), COL.cost, y, { align: 'right' });

    // Subtle bottom separator line
    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.3);
    pdf.line(62, y + 13, W - 40, y + 13);

    y += rowH;

    // Cost detail sub-rows
    if (includeCostDetail) {
      if (t.isAdvancedCost && t.customCosts?.length) {
        const details = calculateTakeoffCostDetails(t, t.totalRealValue);
        for (const detail of details) {
          if (y > H - 60) {
            pdf.addPage();
            pdf.setFillColor(hR, hG, hB);
            pdf.rect(0, 0, W, 50, 'F');
            pdf.setFontSize(13);
            pdf.setFont(font, 'bold');
            pdf.setTextColor(255, 255, 255);
            pdf.text('Takeoff Summary (cont.)', 40, 33);
            pdf.setFontSize(10);
            pdf.setFont(font, 'normal');
            pdf.text(projNameTrunc, W - 40, 33, { align: 'right' });
            y = 70;
            rowIndex = 0;
          }
          pdf.setFontSize(8);
          pdf.setFont(font, 'normal');
          pdf.setTextColor(148, 163, 184);
          pdf.text(`  · ${detail.name}`, COL.name, y);
          pdf.text(formatCurrency(detail.costValue), COL.cost, y, { align: 'right' });
          y += 18;
        }
      } else if (t.costPerUnit) {
        pdf.setFontSize(8);
        pdf.setFont(font, 'normal');
        pdf.setTextColor(148, 163, 184);
        const unitLabel2 = UNIT_LABELS[t.unit || ''] || t.unit ||
          (t.type === 'area' ? 'sq ft' : t.type === 'length' ? 'ft' : 'ea');
        pdf.text(`  · ${formatCurrency(t.costPerUnit)} / ${unitLabel2}`, COL.name, y);
        y += 18;
      }
    }
  };

  // Helper: draw a package group header + its takeoffs + subtotal
  const drawPackageGroup = (pkg: string, takeoffs: typeof selectedTakeoffs) => {
    // Ensure there's room for at least the header + one row
    if (y > H - 110) {
      pdf.addPage();
      pdf.setFillColor(hR, hG, hB);
      pdf.rect(0, 0, W, 50, 'F');
      pdf.setFontSize(13);
      pdf.setFont(font, 'bold');
      pdf.setTextColor(255, 255, 255);
      pdf.text('Takeoff Summary (cont.)', 40, 33);
      pdf.setFontSize(10);
      pdf.setFont(font, 'normal');
      pdf.text(projNameTrunc, W - 40, 33, { align: 'right' });
      y = 70;
      rowIndex = 0;
    }

    // Package header — left accent bar + subtle background
    pdf.setFillColor(hR, hG, hB);
    pdf.rect(40, y - 12, 3, 20, 'F');
    pdf.setFillColor(241, 245, 249);
    pdf.rect(43, y - 12, W - 83, 20, 'F');
    pdf.setFontSize(8);
    pdf.setFont(font, 'bold');
    pdf.setTextColor(hR, hG, hB);
    pdf.text(pkg.toUpperCase(), COL.name, y + 2);

    // Package subtotal (right-aligned in header)
    const pkgTotal = takeoffs.reduce((sum, t) => sum + calculateTakeoffTotalCost(t, t.totalRealValue), 0);
    pdf.setTextColor(100, 116, 139);
    pdf.text(formatCurrency(roundUpTo100(pkgTotal)), COL.cost, y + 2, { align: 'right' });

    y += 22;
    rowIndex = 0; // reset alternating stripes per group

    for (const t of takeoffs) {
      drawTakeoffRow(t);
    }
  };

  // Render grouped takeoffs
  for (const pkg of packageOrder) {
    drawPackageGroup(pkg, packageMap[pkg]);
  }

  // Render ungrouped takeoffs (no package label)
  if (ungrouped.length > 0) {
    if (packageOrder.length > 0) {
      // Add a small spacer if there were grouped items above
      y += 4;
    }
    for (const t of ungrouped) {
      drawTakeoffRow(t);
    }
  }

  // Grand total row
  y += 8;
  pdf.setDrawColor(accentR, accentG, accentB);
  pdf.setLineWidth(0.75);
  pdf.line(40, y, W - 40, y);
  y += 18;
  pdf.setFontSize(11);
  pdf.setFont(font, 'bold');
  pdf.setTextColor(15, 23, 42);
  pdf.text('TOTAL', COL.name, y);
  pdf.text(formatCurrency(roundUpTo100(grandTotal)), COL.cost, y, { align: 'right' });

  // Footer on last takeoff page
  pdf.setFontSize(9);
  pdf.setTextColor(148, 163, 184);
  pdf.setFont(font, 'normal');
  pdf.text(`Prepared ${new Date().toLocaleDateString()}`, W / 2, H - 36, { align: 'center' });
  } // end includeTakeoffList

  // ── TERMS & CONDITIONS PAGE ─────────────────────────────────────────
  if (terms.trim()) {
    onProgress?.('Adding terms…');
    pdf.addPage();
    pdf.setFillColor(hR, hG, hB);
    pdf.rect(0, 0, W, 50, 'F');
    pdf.setFontSize(13);
    pdf.setFont(font, 'bold');
    pdf.setTextColor(255, 255, 255);
    pdf.text('Terms & Conditions', 40, 33);
    pdf.setFontSize(10);
    pdf.setFont(font, 'normal');
    pdf.text(projNameTrunc, W - 40, 33, { align: 'right' });

    let ty = 78;
    pdf.setFontSize(10);
    pdf.setFont(font, 'normal');
    pdf.setTextColor(71, 85, 105);
    const termLines = pdf.splitTextToSize(terms.trim(), W - 80) as string[];
    for (const line of termLines) {
      if (ty > H - 60) {
        pdf.addPage();
        pdf.setFillColor(hR, hG, hB);
        pdf.rect(0, 0, W, 50, 'F');
        pdf.setFontSize(13);
        pdf.setFont(font, 'bold');
        pdf.setTextColor(255, 255, 255);
        pdf.text('Terms & Conditions (cont.)', 40, 33);
        ty = 70;
      }
      pdf.text(line, 40, ty);
      ty += 16;
    }
    pdf.setFontSize(9);
    pdf.setTextColor(148, 163, 184);
    pdf.setFont(font, 'normal');
    pdf.text(`Prepared ${new Date().toLocaleDateString()}`, W / 2, H - 36, { align: 'center' });
  }

  // ── PAGE NUMBERS ────────────────────────────────────────────────────
  const totalPages = (pdf as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    pdf.setFontSize(8);
    pdf.setFont(font, 'normal');
    pdf.setTextColor(148, 163, 184);
    pdf.text(`Page ${i} of ${totalPages}`, W - 40, H - 20, { align: 'right' });
  }

  // ── SAVE (merge with highlights if requested) ────────────────────────
  let pdfBytes: ArrayBuffer;
  if (includeHighlights) {
    // Generate the highlights PDF using the exact same path as the Print button,
    // then merge it with the proposal using pdf-lib.
    const { PDFDocument } = await import('pdf-lib');
    const highlightsBuffer = await buildHighlightsPdf(
      project,
      selectedTakeoffIds,
      highlightQuality,
      (msg) => onProgress?.(msg),
      currentPageIds,
    );
    const proposalBuffer = pdf.output('arraybuffer') as ArrayBuffer;

    const mergedDoc = await PDFDocument.create();

    const proposalDoc = await PDFDocument.load(proposalBuffer);
    const proposalPages = await mergedDoc.copyPages(proposalDoc, proposalDoc.getPageIndices());
    proposalPages.forEach(p => mergedDoc.addPage(p));

    if (highlightsBuffer) {
      const highlightsDoc = await PDFDocument.load(highlightsBuffer);
      const highlightsPages = await mergedDoc.copyPages(highlightsDoc, highlightsDoc.getPageIndices());
      highlightsPages.forEach(p => mergedDoc.addPage(p));
    }

    const mergedBytes = await mergedDoc.save();
    pdfBytes = mergedBytes.buffer.slice(mergedBytes.byteOffset, mergedBytes.byteOffset + mergedBytes.byteLength) as ArrayBuffer;
  } else {
    pdfBytes = pdf.output('arraybuffer') as ArrayBuffer;
  }

  const suggestedName = (proposalCustomTitle || project.name).trim()
    ? `Proposal – ${proposalCustomTitle || project.name}`
    : `Proposal – ${new Date().toLocaleString()}`;

  return { pdfBytes, suggestedName };
}
