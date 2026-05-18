import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, FileImage, Settings, Plus, Trash2, ChevronDown, ChevronRight, ChevronUp, Edit2, Check, X, Loader2, Upload, Search, Printer, Download, Eye, FileText, Hash, ZoomIn, ZoomOut, Maximize, FileSpreadsheet, Calendar, Building2, MapPin, Clock, Link as LinkIcon, Mail, Send, RefreshCw } from 'lucide-react';
import { Project, MeasurementTakeoff, ProjectPage, Printout, TakeoffTemplate, CustomCost, ProjectNote } from '../types';
import { getProject, saveProject, getImage, getImageUrl, saveImage, saveFile, saveBinaryFile, getFile, deleteFile, getTemplates, getActivePages, getProjectNotes, saveProjectNotes, getSettings, getUserPreferences, saveUserPreferences, createShare, sendProjectProposal } from '../utils/store';
import { calculatePolylineLength, calculatePolygonArea, calculateRealValue, formatRealValue, calculateSurfaceAreaPx, formatMeasurement, convertUnit, UNIT_LABELS, calculateTakeoffTotalCost, evaluateMathExpression, calculateTakeoffCostDetails, roundUpTo100, expandArcPoints } from '../utils/math';
import { loadPdfPagesGenerator, detectPageInfo, buildOcrCrop, ocrParamsFor, cleanSheetNumber, cleanDescriptionText } from '../utils/pdf';
import { v4 as uuidv4 } from 'uuid';
import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
import { createWorker } from 'tesseract.js';
import { AddressAutocomplete } from '../components/AddressAutocomplete';
import { NewTakeoffModal } from '../components/NewTakeoffModal';
import { UploadFailuresModal, UploadFailure } from '../components/UploadFailuresModal';
import { StickyNote } from 'lucide-react';
import { useNotes } from '../context/NotesContext';
import { useCollaboration } from '../context/CollaborationContext';

const CustomCostRow: React.FC<{
  item: any;
  index: number;
  unitLabel: string;
  onChange: (index: number, updated: any) => void;
  onRemove: (index: number) => void;
}> = ({ item, index, unitLabel, onChange, onRemove }) => {
  const handleMathBlur = (field: string, value: string) => {
    if (value.startsWith('=')) {
      const result = evaluateMathExpression(value);
      if (result !== null) {
        onChange(index, { ...item, [field]: result.toString() });
      }
    }
  };

  return (
    <div className="flex flex-col gap-2 p-3 bg-white rounded-lg border border-slate-200 shadow-sm">
      <div className="flex gap-2 items-center">
        <select
          value={item.type}
          onChange={(e) => onChange(index, { ...item, type: e.target.value as any })}
          className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-slate-50"
        >
          <option value="flat">Flat Cost</option>
          <option value="yield">Material Yield</option>
          <option value="unit">Cost per {unitLabel}</option>
          <option value="amount_per_units">Rate per {unitLabel}s</option>
        </select>
        <input
          type="text"
          value={item.name}
          onChange={(e) => onChange(index, { ...item, name: e.target.value })}
          placeholder="Line Name"
          className="flex-1 text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
        />
        <button
          onClick={() => onRemove(index)}
          className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>
      
      <div className="flex gap-2 items-center pl-2 border-l-2 border-accent-100">
        {item.type === 'flat' && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Cost:</span>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">$</span>
              <input
                type="text"
                value={item.cost || '0'}
                onChange={(e) => onChange(index, { ...item, cost: e.target.value })}
                onBlur={(e) => handleMathBlur('cost', e.target.value)}
                className="w-24 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
          </div>
        )}
        
        {item.type === 'yield' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Yield:</span>
              <input
                type="text"
                value={item.yield || '0'}
                onChange={(e) => onChange(index, { ...item, yield: e.target.value })}
                onBlur={(e) => handleMathBlur('yield', e.target.value)}
                className="w-20 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
              <span className="text-[10px] text-slate-500">{unitLabel} per unit</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Unit:</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. bags"
                className="w-20 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Cost:</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">$</span>
                <input
                  type="text"
                  value={item.cost || '0'}
                  onChange={(e) => onChange(index, { ...item, cost: e.target.value })}
                  onBlur={(e) => handleMathBlur('cost', e.target.value)}
                  className="w-24 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
                />
              </div>
            </div>
          </>
        )}
        
        {item.type === 'unit' && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Cost per {unitLabel}:</span>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">$</span>
              <input
                type="text"
                value={item.costPerUnit || '0'}
                onChange={(e) => onChange(index, { ...item, costPerUnit: e.target.value })}
                onBlur={(e) => handleMathBlur('costPerUnit', e.target.value)}
                className="w-24 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
          </div>
        )}
        
        {item.type === 'amount_per_units' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Amount:</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">$</span>
                <input
                  type="text"
                  value={item.amount || '0'}
                  onChange={(e) => onChange(index, { ...item, amount: e.target.value })}
                  onBlur={(e) => handleMathBlur('amount', e.target.value)}
                  className="w-20 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Per:</span>
              <input
                type="text"
                value={item.perUnits || '0'}
                onChange={(e) => onChange(index, { ...item, perUnits: e.target.value })}
                onBlur={(e) => handleMathBlur('perUnits', e.target.value)}
                className="w-16 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
              <span className="text-[10px] text-slate-500">{unitLabel}s</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Unit:</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. bags"
                className="w-20 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// Converts a data URL (e.g. "data:application/pdf;base64,...") to a fresh Uint8Array.
function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Hex "#rrggbb" → 0-1 RGB components for pdf-lib's rgb(). Defaults gracefully.
function hexToRgb(hex: string): { r: number; g: number; b: number } {
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
async function buildHighlightsPdf(
  project: Project,
  selectedTakeoffIds: Set<string>,
  _quality: HighlightQuality = 'standard',
  onProgress?: (msg: string) => void,
): Promise<ArrayBuffer | null> {
  const pagesToPrint = project.pages.filter(page =>
    page.measurements.some(m => selectedTakeoffIds.has(m.takeoffId || ''))
  );
  if (pagesToPrint.length === 0) return null;

  const { PDFDocument, StandardFonts, rgb, degrees } = await import('pdf-lib');

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

    if (rotation !== 0) {
      // Vector overlay isn't rotation-aware yet. Skip overlay on rotated pages
      // rather than putting marks in the wrong place. The underlying page still
      // appears in the output PDF correctly.
      console.warn(`Page "${page.name}" has /Rotate=${rotation}° — measurement overlay skipped on this page.`);
      continue;
    }

    // ── Vector overlay: measurements ────────────────────────────────────────
    // SVG path origin is top-left with Y-down (pdf-lib flips to PDF Y-up when
    // drawn at y=pageHeight). All measurement coords are scaled into PDF
    // points first so the drawSvgPath origin maps cleanly.
    const sf = scaleFactor;
    const pdfX = (mx: number) => mx * sf;
    const pdfY = (my: number) => pageHeight - my * sf; // for non-SVG primitives (Y-up)

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
          x: 0, y: pageHeight,
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
  }

  const out = await outDoc.save();
  // pdf-lib returns a Uint8Array; turn it into an ArrayBuffer for the existing
  // saveFile path.
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

// ── Highlight quality presets ────────────────────────────────────────────────
const HIGHLIGHT_QUALITY_PRESETS = {
  full:     { label: 'Full Resolution',              maxDim: Infinity, jpegQuality: 0.90 },
  large:    { label: 'Large  (≈A2 — high quality)',  maxDim: 1680,     jpegQuality: 0.85 },
  standard: { label: 'Standard  (≈A3)',              maxDim: 1190,     jpegQuality: 0.80 },
  compact:  { label: 'Compact  (near A4)',            maxDim: 680,      jpegQuality: 0.72 },
} as const;
type HighlightQuality = keyof typeof HIGHLIGHT_QUALITY_PRESETS;

// ── Per-user localStorage key for proposal preferences ───────────────────────
function getProposalPrefsKey(): string {
  try {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    return `proposal-prefs-${user.id || 'default'}`;
  } catch {
    return 'proposal-prefs-default';
  }
}

export const ProjectView: React.FC = () => {
  const { openNotes } = useNotes();
  const { setPageName } = useCollaboration();
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [project, setProject] = useState<Project | null>(null);
  const [takeoffToDelete, setTakeoffToDelete] = useState<string | null>(null);
  const [printoutToDelete, setPrintoutToDelete] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeletePrintoutConfirm, setShowDeletePrintoutConfirm] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<'pages' | 'takeoffs' | 'printouts' | 'email' | 'notes'>('pages');
  const [showSendProposalModal, setShowSendProposalModal] = useState(false);
  const [sendProposalFileId, setSendProposalFileId] = useState('');
  const [sendProposalMessage, setSendProposalMessage] = useState('');
  const [sendingProposal, setSendingProposal] = useState(false);
  const [expandedThreadKeys, setExpandedThreadKeys] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [projectNote, setProjectNote] = useState<ProjectNote | null>(null);
  const [showTakeoffModal, setShowTakeoffModal] = useState(false);
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);

  const [selectedTakeoffIds, setSelectedTakeoffIds] = useState<Set<string>>(new Set());
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());
  const pagesScrollRef = useRef<HTMLDivElement>(null);
  const [editTakeoffPricePackage, setEditTakeoffPricePackage] = useState('');
  const [isPrinting, setIsPrinting] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [isGeneratingProposal, setIsGeneratingProposal] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [showProposalModal, setShowProposalModal] = useState(false);
  const [proposalIncludeCostDetail, setProposalIncludeCostDetail] = useState(false);
  const [proposalIncludeHighlights, setProposalIncludeHighlights] = useState(false);
  const [proposalCustomTitle, setProposalCustomTitle] = useState('');
  const [proposalHeaderColor, setProposalHeaderColor] = useState('#1e293b');
  const [proposalCoverNotes, setProposalCoverNotes] = useState('');
  const [proposalFontFamily, setProposalFontFamily] = useState<'helvetica' | 'times' | 'courier'>('helvetica');
  const [proposalValidUntil, setProposalValidUntil] = useState('');
  const [proposalTerms, setProposalTerms] = useState('');
  const [proposalIncludeSignature, setProposalIncludeSignature] = useState(false);
  const [proposalIncludeTakeoffList, setProposalIncludeTakeoffList] = useState(true);
  const [highlightQuality, setHighlightQuality] = useState<HighlightQuality>('standard');

  // ── Scroll position memory for pages tab ─────────────────────────────────
  const scrollKey = `projectView-scroll-${projectId}`;
  // Wait for content to load before restoring — firing during isLoading=true
  // restores onto an empty page which then gets reset when content appears.
  useEffect(() => {
    if (activeTab !== 'pages' || isLoading) return;
    const saved = sessionStorage.getItem(scrollKey);
    if (saved) {
      requestAnimationFrame(() => window.scrollTo({ top: parseInt(saved, 10), behavior: 'instant' as ScrollBehavior }));
    }
  }, [activeTab, isLoading]);

  useEffect(() => {
    if (activeTab !== 'pages') return;
    const onScroll = () => sessionStorage.setItem(scrollKey, String(Math.round(window.scrollY)));
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [activeTab, scrollKey]);

  // ── Proposal preference persistence ──────────────────────────────────────
  // Update collaboration page name when project loads
  useEffect(() => {
    if (project) setPageName(project.name);
  }, [project, setPageName]);

  // Load saved prefs on mount: localStorage first (instant), then server (source of truth)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(getProposalPrefsKey());
      if (raw) {
        const p = JSON.parse(raw);
        if (p.headerColor)                setProposalHeaderColor(p.headerColor);
        if (p.fontFamily)                 setProposalFontFamily(p.fontFamily);
        if (p.includeCostDetail != null)  setProposalIncludeCostDetail(p.includeCostDetail);
        if (p.includeHighlights != null)  setProposalIncludeHighlights(p.includeHighlights);
        if (p.includeSignature    != null)  setProposalIncludeSignature(p.includeSignature);
        if (p.includeTakeoffList  != null)  setProposalIncludeTakeoffList(p.includeTakeoffList);
        if (p.highlightQuality)             setHighlightQuality(p.highlightQuality);
      }
    } catch { /* ignore corrupt data */ }

    // Server prefs override localStorage (cross-browser sync)
    getUserPreferences().then(prefs => {
      if (prefs['proposal-headerColor'])                setProposalHeaderColor(prefs['proposal-headerColor']);
      if (prefs['proposal-fontFamily'])                 setProposalFontFamily(prefs['proposal-fontFamily'] as 'helvetica' | 'times' | 'courier');
      if (prefs['proposal-includeCostDetail'] != null)  setProposalIncludeCostDetail(prefs['proposal-includeCostDetail'] === 'true');
      if (prefs['proposal-includeHighlights'] != null)  setProposalIncludeHighlights(prefs['proposal-includeHighlights'] === 'true');
      if (prefs['proposal-includeSignature']    != null)  setProposalIncludeSignature(prefs['proposal-includeSignature'] === 'true');
      if (prefs['proposal-includeTakeoffList']  != null)  setProposalIncludeTakeoffList(prefs['proposal-includeTakeoffList'] === 'true');
      if (prefs['proposal-highlightQuality'])             setHighlightQuality(prefs['proposal-highlightQuality'] as HighlightQuality);
    }).catch(() => { /* offline — localStorage values already applied */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save whenever any persistent pref changes (localStorage + server)
  useEffect(() => {
    // Cache in localStorage (fast, offline-safe)
    try {
      localStorage.setItem(getProposalPrefsKey(), JSON.stringify({
        headerColor:       proposalHeaderColor,
        fontFamily:        proposalFontFamily,
        includeCostDetail: proposalIncludeCostDetail,
        includeHighlights: proposalIncludeHighlights,
        includeSignature:    proposalIncludeSignature,
        includeTakeoffList:  proposalIncludeTakeoffList,
        highlightQuality,
      }));
    } catch { /* ignore quota errors */ }
    // Persist to server (source of truth, cross-browser)
    saveUserPreferences({
      'proposal-headerColor':       proposalHeaderColor,
      'proposal-fontFamily':        proposalFontFamily,
      'proposal-includeCostDetail': String(proposalIncludeCostDetail),
      'proposal-includeHighlights': String(proposalIncludeHighlights),
      'proposal-includeSignature':    String(proposalIncludeSignature),
      'proposal-includeTakeoffList':  String(proposalIncludeTakeoffList),
      'proposal-highlightQuality':    highlightQuality,
    }).catch(() => {});
  }, [proposalHeaderColor, proposalFontFamily, proposalIncludeCostDetail, proposalIncludeHighlights, proposalIncludeSignature, proposalIncludeTakeoffList, highlightQuality]);

  const [editingTakeoff, setEditingTakeoff] = useState<MeasurementTakeoff | null>(null);
  const [editTakeoffName, setEditTakeoffName] = useState('');
  const [editTakeoffColor, setEditTakeoffColor] = useState('');
  const [editTakeoffUnit, setEditTakeoffUnit] = useState('');
  const [editTakeoffCostPerUnit, setEditTakeoffCostPerUnit] = useState<number | ''>('');
  const [isEditTakeoffAdvanced, setIsEditTakeoffAdvanced] = useState(false);
  const [editTakeoffCustomCosts, setEditTakeoffCustomCosts] = useState<any[]>([]);

  const [expandedTakeoffs, setExpandedTakeoffs] = useState<Record<string, boolean>>({});
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingPageName, setEditingPageName] = useState('');
  const [editingPageNumber, setEditingPageNumber] = useState('');
  const [editingPageDescription, setEditingPageDescription] = useState('');
  const [isAddingPages, setIsAddingPages] = useState(false);
  const [addProgress, setAddProgress] = useState({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
  const [selectedPlanSetId, setSelectedPlanSetId] = useState<string>('');
  const [showAddPagesModal, setShowAddPagesModal] = useState(false);
  const [addPagesStep, setAddPagesStep] = useState<'details' | 'name_pages'>('details');
  const [isNamingExistingPages, setIsNamingExistingPages] = useState(false);
  const [pendingPages, setPendingPages] = useState<any[]>([]);
  const [pendingThumbnails, setPendingThumbnails] = useState<Record<string, string>>({});
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionRect, setExtractionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [extractionType, setExtractionType] = useState<'pageNumber' | 'description' | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [interactionMode, setInteractionMode] = useState<'draw' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se' | null>(null);
  const [initialRect, setInitialRect] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [newPlanSetName, setNewPlanSetName] = useState('');
  const [newPlanSetDate, setNewPlanSetDate] = useState(new Date().toISOString().split('T')[0]);
  const [newPlanSetFiles, setNewPlanSetFiles] = useState<File[]>([]);
  const [useExistingPlanSet, setUseExistingPlanSet] = useState(false);
  const [targetPlanSetId, setTargetPlanSetId] = useState('');

  // Upload-failures modal state (mirrors NewProject.tsx) — keeps source File
  // objects so the user can retry missing pages from the existing flow.
  const [uploadFailures, setUploadFailures] = useState<UploadFailure[]>([]);
  const [uploadFilesByName, setUploadFilesByName] = useState<Map<string, File>>(new Map());
  const [uploadTotals, setUploadTotals] = useState({ processed: 0, expected: 0 });
  const [showUploadFailuresModal, setShowUploadFailuresModal] = useState(false);
  const [isRetryingUpload, setIsRetryingUpload] = useState(false);
  const [retryProgress, setRetryProgress] = useState({ status: '', current: 0, total: 0, fileName: '' });
  const [retryPlanSetId, setRetryPlanSetId] = useState<string>('');
  const [searchParams, setSearchParams] = useSearchParams();
  const searchTerm = searchParams.get('search') || '';
  const setSearchTerm = (term: string) => {
    if (term) {
      searchParams.set('search', term);
    } else {
      searchParams.delete('search');
    }
    setSearchParams(searchParams, { replace: true });
  };
  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [editProjectName, setEditProjectName] = useState('');
  const [isEditingDueDate, setIsEditingDueDate] = useState(false);
  const [editDueDate, setEditDueDate] = useState('');
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [editAddress, setEditAddress] = useState('');
  const [isEditingContractor, setIsEditingContractor] = useState(false);
  const [editContractor, setEditContractor] = useState('');
  const [isOptimizingThumbnails, setIsOptimizingThumbnails] = useState(false);
  const [optimizeProgress, setOptimizeProgress] = useState({ current: 0, total: 0 });
  const [activePages, setActivePages] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const removeNewPlanSetFile = (indexToRemove: number) => {
    setNewPlanSetFiles(newPlanSetFiles.filter((_, index) => index !== indexToRemove));
  };

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
    }
    loadTemplates();

    // Poll for active pages
    const fetchActivePages = async () => {
      try {
        const pages = await getActivePages();
        setActivePages(pages);
      } catch (error) {
        console.error('Failed to fetch active pages:', error);
      }
    };
    
    fetchActivePages();
    const interval = setInterval(fetchActivePages, 5000);
    return () => clearInterval(interval);
  }, [projectId]);

  useEffect(() => {
    if (location.state?.activeTab) {
      setActiveTab(location.state.activeTab);
    }
  }, [location.state]);

  const loadTemplates = async () => {
    const data = await getTemplates();
    setTemplates(data);
  };

  const loadProject = async (id: string) => {
    setIsLoading(true);
    const data = await getProject(id);
    if (!data) {
      navigate('/');
      return;
    }
    setProject(data);
    
    if (data.planSets && data.planSets.length > 0) {
      setSelectedPlanSetId('');
    }
    
    setIsLoading(false);
  };

  const handleDeleteTakeoff = async (takeoffId: string) => {
    setTakeoffToDelete(takeoffId);
    setShowDeleteConfirm(true);
  };

  const confirmDeleteTakeoff = async () => {
    if (!project || !takeoffToDelete) return;

    const updatedProject = {
      ...project,
      takeoffs: project.takeoffs.filter(g => g.id !== takeoffToDelete),
      pages: project.pages.map(page => ({
        ...page,
        measurements: page.measurements.map(m => 
          m.takeoffId === takeoffToDelete ? { ...m, takeoffId: undefined } : m
        )
      }))
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    setShowDeleteConfirm(false);
    setTakeoffToDelete(null);
  };

  const confirmDeleteAllTakeoffs = async () => {
    if (!project) return;
    const updatedProject = {
      ...project,
      takeoffs: [],
      pages: project.pages.map(page => ({
        ...page,
        measurements: page.measurements.map(m => ({ ...m, takeoffId: undefined }))
      }))
    };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setShowDeleteAllConfirm(false);
  };

  const handleEditTakeoff = (takeoff: MeasurementTakeoff) => {
    const rawTakeoff = project?.takeoffs.find(t => t.id === takeoff.id) || takeoff;
    setEditingTakeoff(rawTakeoff);
    setEditTakeoffName(rawTakeoff.name);
    setEditTakeoffColor(rawTakeoff.color);
    setEditTakeoffUnit(rawTakeoff.unit || '');
    setEditTakeoffCostPerUnit(rawTakeoff.costPerUnit ?? '');
    setIsEditTakeoffAdvanced(rawTakeoff.isAdvancedCost || false);
    setEditTakeoffCustomCosts(rawTakeoff.customCosts || []);
    setEditTakeoffPricePackage(rawTakeoff.pricePackage || '');
  };

  const handleSaveEditTakeoff = async () => {
    if (!project || !editingTakeoff || !editTakeoffName) return;

    const updatedProject = {
      ...project,
      takeoffs: project.takeoffs.map(g => 
        g.id === editingTakeoff.id 
          ? {
              ...g,
              name: editTakeoffName,
              color: editTakeoffColor,
              unit: editTakeoffUnit || undefined,
              costPerUnit: !isEditTakeoffAdvanced && editTakeoffCostPerUnit !== '' ? Number(editTakeoffCostPerUnit) : undefined,
              isAdvancedCost: isEditTakeoffAdvanced,
              customCosts: isEditTakeoffAdvanced ? editTakeoffCustomCosts.map(c => ({
                ...c,
                cost: evaluateMathExpression(c.cost?.toString() || '') ?? 0,
                yield: evaluateMathExpression(c.yield?.toString() || '') ?? 0,
                costPerUnit: evaluateMathExpression(c.costPerUnit?.toString() || '') ?? 0,
                amount: evaluateMathExpression(c.amount?.toString() || '') ?? 0,
                perUnits: evaluateMathExpression(c.perUnits?.toString() || '') ?? 0,
              })) : undefined,
              pricePackage: editTakeoffPricePackage.trim() || undefined,
            }
          : g
      ),
      pages: project.pages.map(page => ({
        ...page,
        measurements: page.measurements.map(m => 
          m.takeoffId === editingTakeoff.id 
            ? { ...m, color: editTakeoffColor }
            : m
        )
      }))
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    setEditingTakeoff(null);
  };

  const toggleTakeoffExpanded = (takeoffId: string) => {
    setExpandedTakeoffs(prev => ({
      ...prev,
      [takeoffId]: !prev[takeoffId]
    }));
  };

  const handleStartRenamePage = (e: React.MouseEvent, page: ProjectPage) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (activePages.includes(page.id)) {
      alert("This page is currently being viewed by another user and cannot be renamed.");
      return;
    }
    
    setEditingPageId(page.id);
    setEditingPageName(page.name);
    setEditingPageNumber(page.pageNumber || '');
    setEditingPageDescription(page.description || '');
  };

  const handleSaveRenamePage = async (e: React.MouseEvent, pageId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!project) return;

    const num = editingPageNumber.trim();
    const desc = editingPageDescription.trim();
    const newName = num && desc ? `${num} - ${desc}` : (num || desc || editingPageName.trim());

    if (!newName) return;

    const updatedProject = {
      ...project,
      pages: project.pages.map(p => p.id === pageId ? { 
        ...p, 
        name: newName,
        pageNumber: num,
        description: desc
      } : p)
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    setEditingPageId(null);
  };

  const handleCancelRenamePage = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingPageId(null);
  };

  const handleAddPages = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPlanSetFiles.length === 0 || !project || (!newPlanSetName && !useExistingPlanSet)) return;

    setIsAddingPages(true);
    try {
      const planSetId = useExistingPlanSet ? targetPlanSetId : uuidv4();
      let updatedProject = { 
        ...project,
        pages: [...project.pages]
      };

      if (!useExistingPlanSet) {
        const newPlanSet = {
          id: planSetId,
          name: newPlanSetName,
          date: newPlanSetDate,
          createdAt: Date.now(),
        };
        updatedProject = {
          ...updatedProject,
          planSets: [...(updatedProject.planSets || []), newPlanSet]
        };
      }

      const extractedPages: any[] = [];
      const thumbnails: Record<string, string> = {};

      // Build map of existing page numbers for revision detection
      const existingPageNums = new Map<string, string>(); // normalised → display
      for (const pg of project.pages) {
        if (pg.pageNumber?.trim()) {
          existingPageNums.set(pg.pageNumber.trim().toLowerCase(), pg.pageNumber.trim());
        }
      }

      let startingPageNum = updatedProject.pages.length + 1;
      const failures: Array<{ fileName: string; pageNum: number | null; reason: string }> = [];
      let totalExpected = 0;
      let totalProcessed = 0;

      for (let i = 0; i < newPlanSetFiles.length; i++) {
        const file = newPlanSetFiles[i];
        setAddProgress(prev => ({ ...prev, currentFile: i + 1, totalFiles: newPlanSetFiles.length }));

        // Upload the source PDF once for this file. Stream the File directly
        // to the server instead of materializing a base64 dataUrl in the
        // browser — see NewProject.handleProcessFiles for the same pattern.
        let sourcePdfFileId: string | undefined;
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (isPdf) {
          try {
            setAddProgress(prev => ({ ...prev, status: 'uploading source PDF', current: 0, total: 0 }));
            sourcePdfFileId = uuidv4();
            const pdfBlob = file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
            await saveBinaryFile(sourcePdfFileId, pdfBlob);
          } catch (pdfErr) {
            console.warn(`Failed to upload source PDF for ${file.name} — falling back to raster only`, pdfErr);
            sourcePdfFileId = undefined;
          }
        }

        let fileExpected = 0;
        let fileYielded = 0;

        try {
          const generator = loadPdfPagesGenerator(file, (status, current, total) => {
            if (total > 0) fileExpected = total;
            setAddProgress(prev => ({ ...prev, status, current, total }));
          }, undefined, { includeFullPageRaster: !sourcePdfFileId });

          for await (const pageData of generator) {
            fileYielded++;

            if (pageData.error) {
              failures.push({ fileName: file.name, pageNum: pageData.pageNum, reason: pageData.error });
              continue;
            }

            setAddProgress(prev => ({ ...prev, status: 'uploading', current: pageData.pageNum, total: prev.total }));

            try {
              const thumbnailId = uuidv4();
              await saveImage(thumbnailId, pageData.thumbnailDataUrl);

              let imageId = '';
              if (!sourcePdfFileId && pageData.dataUrl) {
                imageId = uuidv4();
                await saveImage(imageId, pageData.dataUrl);
                thumbnails[imageId] = pageData.thumbnailDataUrl;
              } else {
                thumbnails[thumbnailId] = pageData.thumbnailDataUrl;
              }

              const detected = detectPageInfo(pageData.suggestedName, file.name, pageData.extractedText);
              const normNum = detected.pageNumber.trim().toLowerCase();
              const revisionOf = detected.pageNumber && existingPageNums.has(normNum)
                ? existingPageNums.get(normNum)!
                : undefined;

              const newPage = {
                id: uuidv4(),
                name: detected.pageNumber && detected.description
                  ? `${detected.pageNumber} - ${detected.description}`
                  : detected.pageNumber || detected.description || pageData.suggestedName || `Page ${startingPageNum}`,
                pageNumber: detected.pageNumber,
                description: detected.description,
                imageId,
                thumbnailId,
                imageWidth: pageData.width,
                imageHeight: pageData.height,
                extractedText: pageData.extractedText,
                revisionOf,
              };

              extractedPages.push(newPage);

              const newProjectPage = {
                id: newPage.id,
                name: newPage.name,
                pageNumber: newPage.pageNumber,
                description: newPage.description,
                imageId: newPage.imageId,
                thumbnailId: newPage.thumbnailId,
                imageWidth: newPage.imageWidth,
                imageHeight: newPage.imageHeight,
                sourcePdfFileId,
                sourcePdfPageNum: sourcePdfFileId ? pageData.pageNum : undefined,
                extractedText: newPage.extractedText,
                measurements: [],
                scaleConfig: null,
                planSetId,
              };

              updatedProject = {
                ...updatedProject,
                pages: [...updatedProject.pages, newProjectPage]
              };

              totalProcessed++;

              if (startingPageNum % 5 === 0) {
                try {
                  await saveProject(updatedProject);
                  setProject(updatedProject);
                } catch (saveErr) {
                  console.warn('Periodic saveProject failed', saveErr);
                }
              }

              startingPageNum++;
            } catch (perPageErr) {
              console.warn(`Save failed for ${file.name} page ${pageData.pageNum}`, perPageErr);
              failures.push({
                fileName: file.name,
                pageNum: pageData.pageNum,
                reason: String((perPageErr as any)?.message || perPageErr),
              });
            }
          }
        } catch (genErr) {
          console.error(`PDF processing aborted for ${file.name}`, genErr);
          failures.push({
            fileName: file.name,
            pageNum: null,
            reason: `Processing aborted: ${String((genErr as any)?.message || genErr)}`,
          });
        }

        totalExpected += fileExpected;

        if (fileExpected > fileYielded) {
          for (let p = fileYielded + 1; p <= fileExpected; p++) {
            failures.push({
              fileName: file.name,
              pageNum: p,
              reason: 'Page was never reached during processing',
            });
          }
        }

        try {
          await saveProject(updatedProject);
          setProject(updatedProject);
        } catch (saveErr) {
          console.warn('End-of-file saveProject failed', saveErr);
          failures.push({
            fileName: file.name,
            pageNum: null,
            reason: `Could not save project after processing ${file.name}: ${String((saveErr as any)?.message || saveErr)}`,
          });
        }
      }

      const hasFailures = failures.length > 0 || totalProcessed !== totalExpected;
      if (hasFailures) {
        const filesByName = new Map<string, File>();
        for (const f of newPlanSetFiles) filesByName.set(f.name, f);
        setUploadFilesByName(filesByName);
        setUploadFailures(failures);
        setUploadTotals({ processed: totalProcessed, expected: totalExpected });
        setRetryPlanSetId(planSetId);
        setShowUploadFailuresModal(true);
      }

      if (totalProcessed === 0) {
        setIsAddingPages(false);
        setAddProgress({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
        return;
      }

      setPendingPages(extractedPages);
      setPendingThumbnails(thumbnails);
      setAddPagesStep('name_pages');
    } catch (error) {
      console.error('Error processing PDFs:', error);
      alert('Failed to process PDF. Please try another file.');
    } finally {
      setIsAddingPages(false);
      setAddProgress({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
    }
  };

  // Re-render and re-import each failure in the modal. Same per-page logic
  // as the original upload, with page-level failures using the pageNums
  // filter and file-level failures re-running the full file.
  const handleRetryFailedPages = async () => {
    if (!project || uploadFailures.length === 0 || !retryPlanSetId) return;
    setIsRetryingUpload(true);
    setRetryProgress({ status: '', current: 0, total: 0, fileName: '' });

    try {
      const freshProject = await getProject(project.id);
      if (!freshProject) throw new Error('Project not found');
      let workingProject: Project = freshProject;

      const existingPageNums = new Map<string, string>();
      for (const pg of workingProject.pages) {
        if (pg.pageNumber?.trim()) {
          existingPageNums.set(pg.pageNumber.trim().toLowerCase(), pg.pageNumber.trim());
        }
      }

      const byFile = new Map<string, { pageNums: number[]; allPages: boolean }>();
      for (const f of uploadFailures) {
        const entry = byFile.get(f.fileName) ?? { pageNums: [], allPages: false };
        if (f.pageNum == null) entry.allPages = true;
        else entry.pageNums.push(f.pageNum);
        byFile.set(f.fileName, entry);
      }

      const remainingFailures: UploadFailure[] = [];
      const newPendingPages: any[] = [];
      const newThumbnails: Record<string, string> = {};
      let newlyProcessed = 0;
      let nextPageNum = (workingProject.pages.length || 0) + 1;

      for (const [fileName, info] of byFile) {
        const file = uploadFilesByName.get(fileName);
        if (!file) {
          if (info.allPages) {
            remainingFailures.push({ fileName, pageNum: null, reason: 'Source file no longer available for retry' });
          }
          for (const p of info.pageNums) {
            remainingFailures.push({ fileName, pageNum: p, reason: 'Source file no longer available for retry' });
          }
          continue;
        }

        const pageNumsArg = info.allPages ? undefined : info.pageNums;
        const requestedCount = info.allPages ? 0 : info.pageNums.length;
        const succeeded = new Set<number>();
        let yielded = 0;
        let expectedFromGenerator = 0;

        try {
          const generator = loadPdfPagesGenerator(file, (status, current, total) => {
            if (info.allPages && total > 0) expectedFromGenerator = total;
            setRetryProgress({
              status,
              current,
              total: info.allPages ? total : requestedCount,
              fileName,
            });
          }, pageNumsArg);

          for await (const pageData of generator) {
            yielded++;

            if (pageData.error) {
              remainingFailures.push({ fileName, pageNum: pageData.pageNum, reason: pageData.error });
              continue;
            }

            try {
              const imageId = uuidv4();
              const thumbnailId = uuidv4();
              await saveImage(imageId, pageData.dataUrl);
              await saveImage(thumbnailId, pageData.thumbnailDataUrl);
              newThumbnails[imageId] = pageData.thumbnailDataUrl;

              const detected = detectPageInfo(pageData.suggestedName, fileName, pageData.extractedText);
              const normNum = detected.pageNumber.trim().toLowerCase();
              const revisionOf = detected.pageNumber && existingPageNums.has(normNum)
                ? existingPageNums.get(normNum)!
                : undefined;

              const newPage = {
                id: uuidv4(),
                name: detected.pageNumber && detected.description
                  ? `${detected.pageNumber} - ${detected.description}`
                  : detected.pageNumber || detected.description || pageData.suggestedName || `Page ${nextPageNum}`,
                pageNumber: detected.pageNumber,
                description: detected.description,
                imageId,
                thumbnailId,
                imageWidth: pageData.width,
                imageHeight: pageData.height,
                extractedText: pageData.extractedText,
                revisionOf,
              };

              newPendingPages.push(newPage);

              const newProjectPage = {
                id: newPage.id,
                name: newPage.name,
                pageNumber: newPage.pageNumber,
                description: newPage.description,
                imageId: newPage.imageId,
                thumbnailId: newPage.thumbnailId,
                imageWidth: newPage.imageWidth,
                imageHeight: newPage.imageHeight,
                extractedText: newPage.extractedText,
                measurements: [],
                scaleConfig: null,
                planSetId: retryPlanSetId,
              };

              workingProject = {
                ...workingProject,
                pages: [...workingProject.pages, newProjectPage],
              };

              nextPageNum++;
              newlyProcessed++;
              succeeded.add(pageData.pageNum);
            } catch (saveErr) {
              remainingFailures.push({
                fileName,
                pageNum: pageData.pageNum,
                reason: String((saveErr as any)?.message || saveErr),
              });
            }
          }
        } catch (genErr) {
          remainingFailures.push({
            fileName,
            pageNum: null,
            reason: `Retry aborted: ${String((genErr as any)?.message || genErr)}`,
          });
          if (!info.allPages) {
            for (const p of info.pageNums) {
              if (!succeeded.has(p)) {
                remainingFailures.push({ fileName, pageNum: p, reason: 'Page was never reached during retry' });
              }
            }
          }
          continue;
        }

        if (!info.allPages) {
          for (const p of info.pageNums) {
            const alreadyRecorded = remainingFailures.some(f => f.fileName === fileName && f.pageNum === p);
            if (!succeeded.has(p) && !alreadyRecorded) {
              remainingFailures.push({ fileName, pageNum: p, reason: 'Page was not produced during retry' });
            }
          }
        } else if (expectedFromGenerator > yielded) {
          for (let p = yielded + 1; p <= expectedFromGenerator; p++) {
            remainingFailures.push({ fileName, pageNum: p, reason: 'Page was never reached during retry' });
          }
        }
      }

      try {
        await saveProject(workingProject);
        setProject(workingProject);
      } catch (saveErr) {
        remainingFailures.push({
          fileName: '(project save)',
          pageNum: null,
          reason: `Could not save retried pages: ${String((saveErr as any)?.message || saveErr)}`,
        });
      }

      if (newPendingPages.length > 0) {
        setPendingPages(prev => [...prev, ...newPendingPages]);
        setPendingThumbnails(prev => ({ ...prev, ...newThumbnails }));
        if (addPagesStep !== 'name_pages') setAddPagesStep('name_pages');
      }

      setUploadFailures(remainingFailures);
      setUploadTotals(prev => ({ processed: prev.processed + newlyProcessed, expected: prev.expected }));

      if (remainingFailures.length === 0) {
        setShowUploadFailuresModal(false);
      }
    } catch (err) {
      console.error('Retry failed', err);
      alert(`Retry failed: ${(err as any)?.message || err}`);
    } finally {
      setIsRetryingUpload(false);
      setRetryProgress({ status: '', current: 0, total: 0, fileName: '' });
    }
  };

  const toggleTakeoffSelection = (takeoffId: string) => {
    setSelectedTakeoffIds(prev => {
      const next = new Set(prev);
      if (next.has(takeoffId)) {
        next.delete(takeoffId);
      } else {
        next.add(takeoffId);
      }
      return next;
    });
  };

  const handlePrint = async () => {
    if (!project || selectedTakeoffIds.size === 0) return;
    setIsPrinting(true);
    setProgressMessage('Preparing pages…');

    try {
      const pdfBuffer = await buildHighlightsPdf(
        project,
        selectedTakeoffIds,
        highlightQuality,
        (msg) => setProgressMessage(msg),
      );

      if (!pdfBuffer) {
        alert('No pages found with the selected takeoffs.');
        setIsPrinting(false);
        setProgressMessage('');
        return;
      }

      setProgressMessage('Saving…');
      const pdfBlob = new Blob([pdfBuffer], { type: 'application/pdf' });
      const reader = new FileReader();
      reader.readAsDataURL(pdfBlob);
      reader.onloadend = async () => {
        const base64data = reader.result as string;
        const fileId = uuidv4();
        await saveFile(fileId, base64data);

        const newPrintout: Printout = {
          id: uuidv4(),
          name: `Printout - ${new Date().toLocaleString()}`,
          fileId,
          createdAt: Date.now(),
          type: 'pdf',
        };

        const updatedProject = {
          ...project,
          printouts: [...(project.printouts || []), newPrintout],
        };

        await saveProject(updatedProject);
        setProject(updatedProject);
        setIsPrinting(false);
        setProgressMessage('');
        setSelectedTakeoffIds(new Set());
        setActiveTab('printouts');
      };
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF.');
      setIsPrinting(false);
      setProgressMessage('');
    }
  };

  const handleExportExcel = async () => {
    if (!project || selectedTakeoffIds.size === 0) return;
    setIsExportingExcel(true);

    try {
      const selectedTakeoffs = getTakeoffTotals().filter(t => selectedTakeoffIds.has(t.id));

      // Build rows as array-of-arrays for full control over layout
      const rows: any[][] = [];
      rows.push(['Takeoff Name', 'Type', 'Qty', 'Unit Cost', 'Total Cost']);

      // Group by price package (mirrors the UI)
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

      const addTakeoffRows = (takeoff: typeof selectedTakeoffs[0]) => {
        const totalCost = calculateTakeoffTotalCost(takeoff, takeoff.totalRealValue);
        const costDetails = calculateTakeoffCostDetails(takeoff, takeoff.totalRealValue);

        const qtyFormatted = takeoff.totalRealValue > 0
          ? formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false)
          : '-';

        let unitCost: string;
        if (takeoff.isAdvancedCost) {
          unitCost = totalCost > 0 ? `$${(totalCost / (takeoff.totalRealValue || 1)).toFixed(2)} avg/unit` : '-';
        } else {
          unitCost = takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-';
        }

        const totalCostFormatted = totalCost > 0 ? `$${roundUpTo100(totalCost).toLocaleString()}` : '-';

        // Main takeoff row
        rows.push([takeoff.name, takeoff.type, qtyFormatted, unitCost, totalCostFormatted]);

        // Advanced pricing detail sub-rows
        if (takeoff.isAdvancedCost && costDetails.length > 0) {
          costDetails.forEach(d => {
            if (d.quantity !== undefined && d.quantity > 0) {
              const itemUnitCost = d.type === 'yield'
                ? `$${(d.cost || 0).toFixed(2)}/unit`
                : d.type === 'amount_per_units'
                  ? `$${(d.amount || 0).toFixed(2)}/unit`
                  : '';
              rows.push([
                `  └ ${d.name}`,
                '',
                `${d.quantity.toFixed(2)} ${d.quantityUnit || 'units'}`,
                itemUnitCost,
                `$${d.costValue.toFixed(2)}`
              ]);
            } else if (d.type === 'flat') {
              rows.push([`  └ ${d.name}`, '', 'flat', '', `$${d.costValue.toFixed(2)}`]);
            } else if (d.type === 'unit') {
              rows.push([
                `  └ ${d.name}`,
                '',
                qtyFormatted,
                `$${(d.costPerUnit || 0).toFixed(2)}/unit`,
                `$${d.costValue.toFixed(2)}`
              ]);
            }
          });
        }
      };

      for (const pkg of packageOrder) {
        rows.push([`── ${pkg} ──`, '', '', '', '']);
        packageMap[pkg].forEach(addTakeoffRows);
      }
      ungrouped.forEach(addTakeoffRows);

      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [
        { wch: 36 },
        { wch: 10 },
        { wch: 18 },
        { wch: 18 },
        { wch: 16 },
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Takeoffs");
      
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const excelBlob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      
      const reader = new FileReader();
      reader.readAsDataURL(excelBlob);
      reader.onloadend = async () => {
        const base64data = reader.result as string;
        const fileId = uuidv4();
        await saveFile(fileId, base64data);
        
        const newPrintout: Printout = {
          id: uuidv4(),
          name: `Excel Export - ${new Date().toLocaleString()}`,
          fileId,
          createdAt: Date.now(),
          type: 'excel',
        };
        
        const updatedProject = {
          ...project,
          printouts: [...(project.printouts || []), newPrintout],
        };
        
        await saveProject(updatedProject);
        setProject(updatedProject);
        setIsExportingExcel(false);
        setSelectedTakeoffIds(new Set());
        setActiveTab('printouts');
      };
    } catch (error) {
      console.error('Error generating Excel:', error);
      alert('Failed to generate Excel.');
      setIsExportingExcel(false);
    }
  };

  const formatCurrency = (n: number) =>
    '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleGenerateProposal = async (
    includeCostDetail: boolean,
    includeHighlights: boolean,
    headerColor = '#1e293b',
    coverNotes = '',
    fontFamily: 'helvetica' | 'times' | 'courier' = 'helvetica',
    validUntil = '',
    terms = '',
    includeSignature = false,
    includeTakeoffList = true,
  ) => {
    if (!project || selectedTakeoffIds.size === 0) return;
    setShowProposalModal(false);
    setIsGeneratingProposal(true);
    setProgressMessage('Building cover page…');

    try {
      const settings = await getSettings();
      const selectedTakeoffs = getTakeoffTotals().filter(t => selectedTakeoffIds.has(t.id));

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
      setProgressMessage('Adding scope details…');
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
        setProgressMessage('Adding terms…');
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
      let finalBlob: Blob;
      if (includeHighlights) {
        // Generate the highlights PDF using the exact same path as the Print button,
        // then merge it with the proposal using pdf-lib.
        const { PDFDocument } = await import('pdf-lib');
        const highlightsBuffer = await buildHighlightsPdf(
          project,
          selectedTakeoffIds,
          highlightQuality,
          (msg) => setProgressMessage(msg),
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
        finalBlob = new Blob([mergedBytes], { type: 'application/pdf' });
      } else {
        finalBlob = pdf.output('blob');
      }

      setProgressMessage('Saving…');
      const pdfBlob = finalBlob;
      const reader = new FileReader();
      reader.readAsDataURL(pdfBlob);
      reader.onloadend = async () => {
        const base64data = reader.result as string;
        const fileId = uuidv4();
        await saveFile(fileId, base64data);
        const printoutName = (proposalCustomTitle || project.name).trim()
          ? `Proposal – ${proposalCustomTitle || project.name}`
          : `Proposal – ${new Date().toLocaleString()}`;
        const newPrintout: Printout = {
          id: uuidv4(),
          name: printoutName,
          fileId,
          createdAt: Date.now(),
          type: 'pdf',
        };
        const updatedProject = {
          ...project,
          printouts: [...(project.printouts || []), newPrintout],
        };
        await saveProject(updatedProject);
        setProject(updatedProject);
        setIsGeneratingProposal(false);
        setProgressMessage('');
        setSelectedTakeoffIds(new Set());
        setActiveTab('printouts');
      };
    } catch (error) {
      console.error('Error generating proposal:', error);
      alert('Failed to generate proposal PDF.');
      setIsGeneratingProposal(false);
      setProgressMessage('');
    }
  };

  const handleDeletePrintout = (printoutId: string) => {
    setPrintoutToDelete(printoutId);
    setShowDeletePrintoutConfirm(true);
  };

  const confirmDeletePrintout = async () => {
    if (!project || !printoutToDelete) return;
    
    const printout = project.printouts?.find(p => p.id === printoutToDelete);
    if (!printout) {
      setShowDeletePrintoutConfirm(false);
      setPrintoutToDelete(null);
      return;
    }

    const updatedProject = {
      ...project,
      printouts: project.printouts?.filter(p => p.id !== printoutToDelete) || [],
    };

    await saveProject(updatedProject);
    await deleteFile(printout.fileId);
    setProject(updatedProject);
    setShowDeletePrintoutConfirm(false);
    setPrintoutToDelete(null);
  };

  const handleDownloadPrintout = async (printout: Printout) => {
    const dataUrl = await getFile(printout.fileId);
    if (!dataUrl) return;

    const link = document.createElement('a');
    link.href = dataUrl;
    const isExcel = printout.type === 'excel' || dataUrl.startsWith('data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const extension = isExcel ? '.xlsx' : '.pdf';
    link.download = printout.name.endsWith(extension) ? printout.name : `${printout.name}${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleViewPrintout = async (printout: Printout) => {
    const dataUrl = await getFile(printout.fileId);
    if (!dataUrl) return;

    if (printout.type === 'excel' || dataUrl.startsWith('data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
      // Open Excel files in the Spreadsheet Editor
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const fileName = printout.name.endsWith('.xlsx') ? printout.name : `${printout.name}.xlsx`;
      const file = new File([blob], fileName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const source = projectId
        ? { projectId, printoutId: printout.id, fileId: printout.fileId }
        : undefined;
      navigate('/spreadsheet-editor', { state: { file, source } });
    } else {
      // Convert data URL to File and open in the PDF Editor. Pass source info so
      // Save in the editor overwrites this same printout via the file API.
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const fileName = printout.name.endsWith('.pdf') ? printout.name : `${printout.name}.pdf`;
      const file = new File([blob], fileName, { type: 'application/pdf' });
      const source = projectId
        ? { projectId, printoutId: printout.id, fileId: printout.fileId }
        : undefined;
      navigate('/pdf-editor', { state: { file, source } });
    }
  };

  const copyShareUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      alert(`Share link copied to clipboard:\n${url}`);
    } catch {
      // Clipboard API not available (non-HTTPS/non-localhost) — show the URL directly
      window.prompt('Copy this share link (Ctrl+A, Ctrl+C):', url);
    }
  };

  const handleSharePrintout = async (printout: Printout) => {
    try {
      const id = await createShare('printout', printout.fileId, printout.name);
      const settings = await getSettings();
      const host = (settings.publicHost || window.location.origin).replace(/\/$/, '');
      await copyShareUrl(`${host}/share/${id}`);
    } catch {
      alert('Failed to create share link');
    }
  };

  const handleSharePage = async (page: { imageId: string; name?: string; description?: string }) => {
    try {
      const id = await createShare('page', page.imageId, page.name || page.description || 'Page');
      const settings = await getSettings();
      const host = (settings.publicHost || window.location.origin).replace(/\/$/, '');
      await copyShareUrl(`${host}/share/${id}`);
    } catch {
      alert('Failed to create share link');
    }
  };

  const handleShareSelectedPages = async () => {
    if (!project || selectedPageIds.size === 0) return;
    try {
      const settings = await getSettings();
      const host = (settings.publicHost || window.location.origin).replace(/\/$/, '');

      if (selectedPageIds.size === 1) {
        // Single page — use the simple per-image share
        const pid = [...selectedPageIds][0];
        const pg = project.pages.find(p => p.id === pid);
        if (!pg) return;
        const id = await createShare('page', pg.imageId, pg.name || 'Page');
        await copyShareUrl(`${host}/share/${id}`);
        return;
      }

      // Multiple pages — create one combined share
      const orderedPages = project.pages.filter(p => selectedPageIds.has(p.id));
      const payload = orderedPages.map(p => ({
        imageId: p.imageId,
        name: p.name || 'Page',
        pageNumber: p.pageNumber,
      }));
      // Deduplicate by sorted imageId list so the same selection reuses the existing share
      const resourceId = JSON.stringify(payload);
      const id = await createShare('pages', resourceId, project.name);
      await copyShareUrl(`${host}/share/${id}`);
    } catch {
      alert('Failed to create share link');
    }
  };

  const handleOpenNamePages = () => {
    if (!project) return;
    
    // Populate pendingPages with existing filtered pages
    const existingPages = filteredPages.map(p => ({
      ...p,
      pageNumber: p.pageNumber || '',
      description: p.description || p.name || '',
    }));
    
    const thumbnails: Record<string, string> = {};
    filteredPages.forEach(p => {
      thumbnails[p.imageId] = getImageUrl(p.thumbnailId || p.imageId);
    });
    
    setPendingPages(existingPages);
    setPendingThumbnails(thumbnails);
    setAddPagesStep('name_pages');
    setIsNamingExistingPages(true);
    setShowAddPagesModal(true);
  };

  const handleConfirmAddPages = async () => {
    if (!project) return;
    setIsAddingPages(true);
    try {
      // The pages are already added to the project, we just need to update their names
      const updatedProject = { 
        ...project,
        pages: [...project.pages]
      };
      
      pendingPages.forEach(p => {
        const pageIndex = updatedProject.pages.findIndex(pp => pp.id === p.id);
        if (pageIndex !== -1) {
          updatedProject.pages[pageIndex] = {
            ...updatedProject.pages[pageIndex],
            name: p.pageNumber && p.description ? `${p.pageNumber} - ${p.description}` : (p.pageNumber || p.description || p.name),
            pageNumber: p.pageNumber,
            description: p.description,
          };
        }
      });

      await saveProject(updatedProject);
      setProject(updatedProject);
      
      if (!isNamingExistingPages) {
        // Find the planSetId from the first pending page
        const planSetId = updatedProject.pages.find(p => p.id === pendingPages[0]?.id)?.planSetId;
        if (planSetId) {
          setSelectedPlanSetId(planSetId);
        }
      }
      
      setShowAddPagesModal(false);
      setAddPagesStep('details');
      setIsNamingExistingPages(false);
      setNewPlanSetName('');
      setNewPlanSetFiles([]);
      setPendingPages([]);
      setPendingThumbnails({});
      setUseExistingPlanSet(false);
      setTargetPlanSetId('');
    } catch (error) {
      console.error('Error adding pages:', error);
      alert('Failed to add pages.');
    } finally {
      setIsAddingPages(false);
    }
  };

  const updatePendingPageField = (id: string, field: string, value: string) => {
    setPendingPages(prev => prev.map(p => {
      if (p.id === id) {
        const updated = { ...p, [field]: value };
        // Auto-update name based on number and description
        if (field === 'pageNumber' || field === 'description') {
          const num = field === 'pageNumber' ? value : (p.pageNumber || '');
          const desc = field === 'description' ? value : (p.description || '');
          updated.name = num && desc ? `${num} - ${desc}` : (num || desc || p.name);
        }
        return updated;
      }
      return p;
    }));
  };

  const handleExtractText = async (applyToAll: boolean) => {
    if (!previewPageId || !extractionRect || !extractionType) return;

    const page = pendingPages.find(p => p.id === previewPageId);
    if (!page) return;

    const mode = extractionType;
    const region = { ...extractionRect };
    const cleanValue = (t: string) => (mode === 'pageNumber' ? cleanSheetNumber(t) : cleanDescriptionText(t));

    setIsExtracting(true);
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    try {
      worker = await createWorker('eng', 1, {
        langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
      });
      await worker.setParameters(ocrParamsFor(mode));

      const recognizePage = async (targetPage: any): Promise<string> => {
        const cropDataUrl = await buildOcrCrop(getImageUrl(targetPage.imageId), region);
        const { data: { text } } = await worker!.recognize(cropDataUrl);
        return cleanValue(text || '');
      };

      if (applyToAll) {
        const updatedPages = [...pendingPages];
        for (let i = 0; i < updatedPages.length; i++) {
          const value = await recognizePage(updatedPages[i]);
          const num = mode === 'pageNumber' ? value : (updatedPages[i].pageNumber || '');
          const desc = mode === 'description' ? value : (updatedPages[i].description || '');
          updatedPages[i] = {
            ...updatedPages[i],
            [mode]: value,
            name: num && desc ? `${num} - ${desc}` : (num || desc || updatedPages[i].name),
          };
        }
        setPendingPages(updatedPages);
      } else {
        const value = await recognizePage(page);
        updatePendingPageField(previewPageId, mode, value);
      }

      setExtractionRect(null);
      setExtractionType(null);
    } catch (error) {
      console.error('Extraction error:', error);
      alert('Failed to extract text. Please try again.');
    } finally {
      if (worker) await worker.terminate();
      setIsExtracting(false);
    }
  };

  // Calculate totals for takeoffs across all pages
  const getTakeoffTotals = () => {
    if (!project) return [];

    const pagesToCalculate = project.pages;

    return project.takeoffs.map(takeoff => {
      let totalRealValue = 0;
      let displayUnit = takeoff.unit || '';
      
      const pageBreakdown: { pageId: string; pageName: string; realValue: number; unit: string }[] = [];

      pagesToCalculate.forEach(page => {
        const takeoffMeasurements = page.measurements.filter(m => m.takeoffId === takeoff.id);
        
        if (takeoffMeasurements.length > 0) {
          let pageRealValue = 0;
          let pageUnit = '';

          takeoffMeasurements.forEach(m => {
            // Determine which scale to use
            let currentScale = page.scaleConfig;
            if (page.isMultiRegion && m.regionId) {
              const region = page.scaleRegions?.find(r => r.id === m.regionId);
              if (region?.scaleConfig) {
                currentScale = region.scaleConfig;
              }
            }

            if (takeoff.type === 'count') {
              pageRealValue += 1;
              pageUnit = 'each';
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
                
                pageRealValue += convertedVal;
                pageUnit = targetUnit.startsWith('sq ') ? targetUnit : (takeoff.type === 'area' && !targetUnit.startsWith('sq ') ? `sq ${targetUnit}` : targetUnit);
              }
            }
          });

          if (pageRealValue > 0) {
            totalRealValue += pageRealValue;
            if (!displayUnit) displayUnit = pageUnit;
            
            pageBreakdown.push({
              pageId: page.id,
              pageName: page.name,
              realValue: pageRealValue,
              unit: pageUnit
            });
          }
        }
      });

      return {
        ...takeoff,
        totalRealValue,
        unit: takeoff.unit || displayUnit, // Keep the original unit if it was set, otherwise use the detected one
        pageBreakdown
      };
    });
  };

  const handleToggleStatus = async (field: 'submitted' | 'responded' | 'accepted') => {
    if (!project) return;
    
    const updatedProject = {
      ...project,
      [field]: !project[field]
    };
    
    await saveProject(updatedProject);
    setProject(updatedProject);
  };

  const handleSaveDueDate = async () => {
    if (!project) return;
    const updatedProject = {
      ...project,
      bidDueDate: editDueDate ? new Date(editDueDate).getTime() : undefined
    };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setIsEditingDueDate(false);
  };

  const handleSaveAddress = async () => {
    if (!project) return;
    const updatedProject = {
      ...project,
      address: editAddress || undefined
    };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setIsEditingAddress(false);
  };

  const handleSaveContractor = async () => {
    if (!project) return;
    const updatedProject = {
      ...project,
      contractor: editContractor || undefined
    };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setIsEditingContractor(false);
  };

  const handleOptimizeThumbnails = async () => {
    if (!project) return;
    
    const pagesToOptimize = project.pages.filter(p => !p.thumbnailId);
    if (pagesToOptimize.length === 0) return;

    setIsOptimizingThumbnails(true);
    setOptimizeProgress({ current: 0, total: pagesToOptimize.length });

    const updatedPages = [...project.pages];

    for (let i = 0; i < pagesToOptimize.length; i++) {
      const page = pagesToOptimize[i];
      setOptimizeProgress({ current: i + 1, total: pagesToOptimize.length });
      
      try {
        // Load the full image
        const imgUrl = await getFile(page.imageId);
        if (!imgUrl) continue;

        const img = new Image();
        img.src = imgUrl;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });

        // Generate thumbnail
        const thumbCanvas = document.createElement('canvas');
        const thumbCtx = thumbCanvas.getContext('2d');
        const thumbScale = 400 / Math.max(img.width, img.height);
        thumbCanvas.width = img.width * thumbScale;
        thumbCanvas.height = img.height * thumbScale;
        
        if (thumbCtx) {
          thumbCtx.drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height);
          const thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);
          
          const thumbnailId = uuidv4();
          await saveImage(thumbnailId, thumbnailDataUrl);
          
          // Update page
          const pageIndex = updatedPages.findIndex(p => p.id === page.id);
          if (pageIndex !== -1) {
            updatedPages[pageIndex] = { ...updatedPages[pageIndex], thumbnailId };
          }
        }
      } catch (err) {
        console.error(`Failed to optimize thumbnail for page ${page.name}`, err);
      }
    }

    const updatedProject = { ...project, pages: updatedPages };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setIsOptimizingThumbnails(false);
  };

  const getDueDateColor = () => {
    if (!project || project.submitted || !project.bidDueDate) return 'text-slate-500';
    
    const now = Date.now();
    const diff = project.bidDueDate - now;
    const days = diff / (1000 * 60 * 60 * 24);

    if (days < 0) return 'text-purple-600 font-bold';
    if (days <= 3) return 'text-red-600 font-bold';
    if (days <= 14) return 'text-amber-600 font-bold';
    
    return 'text-slate-500';
  };

  const filteredPages = useMemo(() => {
    if (!project) return [];

    let allowedPlanSets = project.planSets || [];
    
    if (selectedPlanSetId) {
      const selectedPlanSet = allowedPlanSets.find(ps => ps.id === selectedPlanSetId);
      if (selectedPlanSet) {
        allowedPlanSets = allowedPlanSets.filter(ps => {
          if (!ps.date || !selectedPlanSet.date) return ps.createdAt <= selectedPlanSet.createdAt;
          if (ps.date === selectedPlanSet.date) return ps.createdAt <= selectedPlanSet.createdAt;
          return ps.date < selectedPlanSet.date;
        });
      }
    }

    const allowedPlanSetIds = new Set(allowedPlanSets.map(ps => ps.id));

    const candidatePages = project.pages.filter(page =>
      !page.planSetId || allowedPlanSetIds.has(page.planSetId)
    );

    // Revision dedup: when the SAME pageNumber appears in multiple plan
    // sets, only the latest plan set's pages are shown. Within a single
    // plan set we never collapse pages — automatic page-number detection
    // (filename / OCR) can give multiple pages the same number on initial
    // upload, and those are distinct pages, not revisions of each other.
    const latestPlanSetByPageNumber = new Map<string, string | undefined>();
    candidatePages.forEach(page => {
      if (!page.pageNumber) return;
      const numKey = page.pageNumber.trim().toLowerCase();
      const currentLatest = latestPlanSetByPageNumber.get(numKey);
      if (currentLatest === undefined) {
        latestPlanSetByPageNumber.set(numKey, page.planSetId);
        return;
      }
      if (currentLatest === page.planSetId) return;
      const existingPlanSet = allowedPlanSets.find(ps => ps.id === currentLatest);
      const currentPlanSet = allowedPlanSets.find(ps => ps.id === page.planSetId);
      if (existingPlanSet && currentPlanSet) {
        const isNewer = currentPlanSet.date && existingPlanSet.date
          ? (currentPlanSet.date > existingPlanSet.date || (currentPlanSet.date === existingPlanSet.date && currentPlanSet.createdAt > existingPlanSet.createdAt))
          : currentPlanSet.createdAt > existingPlanSet.createdAt;
        if (isNewer) latestPlanSetByPageNumber.set(numKey, page.planSetId);
      } else if (!existingPlanSet && currentPlanSet) {
        latestPlanSetByPageNumber.set(numKey, page.planSetId);
      }
    });

    const visiblePages = candidatePages.filter(page => {
      if (!page.pageNumber) return true;
      const numKey = page.pageNumber.trim().toLowerCase();
      return latestPlanSetByPageNumber.get(numKey) === page.planSetId;
    });

    const searchLower = searchTerm.toLowerCase();
    return visiblePages.filter(page => {
      const matchesSearch = page.name.toLowerCase().includes(searchLower) ||
                            (page.pageNumber && page.pageNumber.toLowerCase().includes(searchLower)) ||
                            (page.description && page.description.toLowerCase().includes(searchLower)) ||
                            (page.extractedText && page.extractedText.toLowerCase().includes(searchLower));
      return matchesSearch;
    }).sort((a, b) => {
      const nameA = a.pageNumber || a.name || '';
      const nameB = b.pageNumber || b.name || '';
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [project, selectedPlanSetId, searchTerm]);

  const handleSaveProjectName = async () => {
    if (!project || !editProjectName.trim()) return;
    
    try {
      const updatedProject = { ...project, name: editProjectName.trim() };
      await saveProject(updatedProject);
      setProject(updatedProject);
      setIsEditingProjectName(false);
    } catch (error) {
      console.error('Failed to update project name:', error);
      alert('Failed to update project name. Please try again.');
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex justify-center items-center">
        <div className="w-8 h-8 border-4 border-accent-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-4 md:p-8 font-sans">

      {/* ── PDF generation progress overlay ── */}
      {(isPrinting || isGeneratingProposal || isExportingExcel) && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl p-8 w-full max-w-xs mx-4 flex flex-col items-center gap-5">
            <Loader2 size={44} className="text-accent-600 animate-spin" />
            <div className="text-center space-y-2">
              <p className="font-semibold text-slate-800 dark:text-slate-100 text-base">
                {isPrinting
                  ? 'Generating PDF…'
                  : isGeneratingProposal
                  ? 'Generating Proposal…'
                  : 'Exporting to Excel…'}
              </p>
              {progressMessage && (
                <p className="text-sm text-slate-500 dark:text-slate-400">{progressMessage}</p>
              )}
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">This may take a moment for large documents</p>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 mb-4 md:mb-6 transition-colors font-medium text-sm md:text-base">
          <ArrowLeft size={18} />
          Back to Projects
        </Link>
        
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-6 md:mb-8 gap-4 md:gap-6">
          <div className="w-full">
            {isEditingProjectName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editProjectName}
                  onChange={(e) => setEditProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveProjectName();
                    if (e.key === 'Escape') setIsEditingProjectName(false);
                  }}
                  className="text-xl md:text-3xl font-bold text-slate-900 dark:text-white border-b-2 border-accent-500 focus:outline-none bg-transparent dark:bg-transparent px-1 min-w-[300px]"
                  autoFocus
                />
                <button
                  onClick={handleSaveProjectName}
                  className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                >
                  <Check size={20} />
                </button>
                <button
                  onClick={() => setIsEditingProjectName(false)}
                  className="p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3 group">
                <h1 className="text-xl md:text-3xl font-bold text-slate-900 dark:text-white break-words leading-tight">{project.name}</h1>
                <button
                  onClick={() => {
                    setEditProjectName(project.name);
                    setIsEditingProjectName(true);
                  }}
                  className="p-1.5 text-slate-400 hover:text-accent-600 opacity-0 group-hover:opacity-100 transition-all rounded-lg hover:bg-accent-50"
                  title="Edit project name"
                >
                  <Edit2 size={18} />
                </button>
              </div>
            )}
            
            <div className="flex flex-wrap gap-2 mt-3 md:mt-4">
              <button
                onClick={() => handleToggleStatus('submitted')}
                className={`px-2.5 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border ${
                  project.submitted 
                    ? 'bg-accent-600 text-white border-accent-600 shadow-sm'
                    : 'bg-white dark:bg-slate-800 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:border-accent-300 hover:text-accent-500'
                }`}
              >
                Submitted
              </button>
              <button
                onClick={() => handleToggleStatus('responded')}
                className={`px-2.5 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border ${
                  project.responded 
                    ? 'bg-amber-500 text-white border-amber-500 shadow-sm'
                    : 'bg-white dark:bg-slate-800 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:border-amber-300 hover:text-amber-500'
                }`}
              >
                Responded
              </button>
              <button
                onClick={() => handleToggleStatus('accepted')}
                className={`px-2.5 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border ${
                  project.accepted 
                    ? 'bg-emerald-500 text-white border-emerald-500 shadow-sm'
                    : 'bg-white dark:bg-slate-800 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:border-emerald-300 hover:text-emerald-500'
                }`}
              >
                Accepted
              </button>
              <button
                onClick={() => projectId && openNotes(projectId)}
                className="px-3 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border bg-white text-accent-600 border-accent-200 hover:border-accent-400 hover:bg-accent-50 flex items-center gap-1.5 shadow-sm"
              >
                <StickyNote size={14} />
                Notes Board
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center gap-3 md:gap-4 mt-4 text-xs md:text-sm text-slate-500 dark:text-slate-400">
              <div className="flex items-center gap-2 bg-white/50 dark:bg-slate-700/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <Calendar size={14} className="text-slate-400 flex-shrink-0" />
                <span className="truncate">Created {new Date(project.createdAt).toLocaleDateString()}</span>
              </div>
              
              <div className="flex items-center gap-2 bg-white/50 dark:bg-slate-700/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <Building2 size={14} className="text-slate-400 flex-shrink-0" />
                {isEditingContractor ? (
                  <div className="flex items-center gap-1 flex-1">
                    <input
                      type="text"
                      value={editContractor}
                      onChange={(e) => setEditContractor(e.target.value)}
                      placeholder="Contractor"
                      className="w-full border border-slate-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent-500"
                    />
                    <button onClick={handleSaveContractor} className="text-green-600 hover:bg-green-50 p-1 rounded">
                      <Check size={14} />
                    </button>
                    <button onClick={() => setIsEditingContractor(false)} className="text-slate-400 hover:bg-slate-100 p-1 rounded">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group flex-1 min-w-0">
                    <span className="truncate">{project.contractor || 'No contractor'}</span>
                    <button 
                      onClick={() => {
                        setEditContractor(project.contractor || '');
                        setIsEditingContractor(true);
                      }}
                      className="text-slate-400 hover:text-accent-500 transition-opacity p-1"
                    >
                      <Edit2 size={12} />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 bg-white/50 dark:bg-slate-700/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <MapPin size={14} className="text-slate-400 flex-shrink-0" />
                {isEditingAddress ? (
                  <div className="flex items-center gap-1 flex-1">
                    <AddressAutocomplete
                      value={editAddress}
                      onChange={setEditAddress}
                      placeholder="Address"
                    />
                    <button onClick={handleSaveAddress} className="text-green-600 hover:bg-green-50 p-1 rounded">
                      <Check size={14} />
                    </button>
                    <button onClick={() => setIsEditingAddress(false)} className="text-slate-400 hover:bg-slate-100 p-1 rounded">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group flex-1 min-w-0">
                    {project.address ? (
                      <a 
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(project.address)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-accent-600 hover:underline transition-colors truncate"
                      >
                        {project.address}
                      </a>
                    ) : (
                      <span className="truncate">No address</span>
                    )}
                    <button 
                      onClick={() => {
                        setEditAddress(project.address || '');
                        setIsEditingAddress(true);
                      }}
                      className="text-slate-400 hover:text-accent-500 transition-opacity p-1"
                    >
                      <Edit2 size={12} />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 bg-white/50 dark:bg-slate-700/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <Clock size={14} className="text-slate-400 flex-shrink-0" />
                {isEditingDueDate ? (
                  <div className="flex items-center gap-1 flex-1">
                    <input
                      type="date"
                      value={editDueDate}
                      onChange={(e) => setEditDueDate(e.target.value)}
                      className="w-full border border-slate-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent-500"
                    />
                    <button onClick={handleSaveDueDate} className="text-green-600 hover:bg-green-50 p-1 rounded">
                      <Check size={14} />
                    </button>
                    <button onClick={() => setIsEditingDueDate(false)} className="text-slate-400 hover:bg-slate-100 p-1 rounded">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group flex-1 min-w-0">
                    <span className={`${getDueDateColor()} truncate`}>
                      Due: {project.bidDueDate ? new Date(project.bidDueDate).toLocaleDateString() : 'Not set'}
                    </span>
                    <button 
                      onClick={() => {
                        setEditDueDate(project.bidDueDate ? new Date(project.bidDueDate).toISOString().split('T')[0] : '');
                        setIsEditingDueDate(true);
                      }}
                      className="text-slate-400 hover:text-accent-600 transition-opacity p-1"
                    >
                      <Edit2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          {project.planSets && project.planSets.length > 0 && (
            <div className="flex items-center gap-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 shadow-sm w-full md:w-auto mt-2 md:mt-0">
              <span className="text-xs md:text-sm text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">Plan Set:</span>
              <select
                value={selectedPlanSetId}
                onChange={(e) => setSelectedPlanSetId(e.target.value)}
                className="bg-transparent dark:bg-transparent text-xs md:text-sm font-medium text-slate-700 dark:text-slate-300 outline-none w-full"
              >
                <option value="">All Plan Sets</option>
                {project.planSets.map(ps => (
                  <option key={ps.id} value={ps.id}>
                    {ps.name} {ps.date ? `(${ps.date})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-700 mb-6 overflow-x-auto no-scrollbar -mx-4 px-4 md:mx-0 md:px-0">
          <button
            onClick={() => setActiveTab('pages')}
            className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap ${
              activeTab === 'pages' ? 'text-accent-600' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            Pages
            {activeTab === 'pages' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-600" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('takeoffs')}
            className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap ${
              activeTab === 'takeoffs' ? 'text-accent-600' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            Takeoffs
            {activeTab === 'takeoffs' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-600" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('printouts')}
            className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap ${
              activeTab === 'printouts' ? 'text-accent-600' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            Printouts
            {activeTab === 'printouts' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-600" />
            )}
          </button>
          {project.email && (
            <button
              onClick={() => setActiveTab('email')}
              className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === 'email' ? 'text-accent-600' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              <Mail size={14} /> Email
              {project.emails && project.emails.length > 1 && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300">
                  {project.emails.length}
                </span>
              )}
              {activeTab === 'email' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-600" />
              )}
            </button>
          )}
        </div>

        {activeTab === 'pages' ? (
          <div className="space-y-6">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
              <div className="relative flex-1 w-full max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="text"
                  placeholder="Search pages and text..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-600 rounded-xl text-sm dark:text-white dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-accent-500 shadow-sm"
                />
              </div>
              <div className="flex flex-wrap gap-2 w-full lg:w-auto">
                {selectedPageIds.size > 0 && (
                  <>
                    <button
                      onClick={handleShareSelectedPages}
                      className="flex-1 lg:flex-none px-4 py-2 bg-accent-600 text-white rounded-lg text-sm font-medium hover:bg-accent-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
                    >
                      <LinkIcon size={16} />
                      Share ({selectedPageIds.size})
                    </button>
                    <button
                      onClick={() => setSelectedPageIds(new Set())}
                      className="flex-1 lg:flex-none px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition-colors flex items-center justify-center gap-2 shadow-sm"
                    >
                      <X size={16} />
                      Deselect All
                    </button>
                  </>
                )}
                {project.pages.some(p => !p.thumbnailId) && (
                  <button
                    onClick={handleOptimizeThumbnails}
                    disabled={isOptimizingThumbnails}
                    className="flex-1 lg:flex-none px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                  >
                    {isOptimizingThumbnails ? (
                      <><Loader2 size={16} className="animate-spin" /> ({optimizeProgress.current}/{optimizeProgress.total})</>
                    ) : (
                      <><Settings size={16} /> Optimize</>
                    )}
                  </button>
                )}
                <button
                  onClick={handleOpenNamePages}
                  className="flex-1 lg:flex-none px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition-colors flex items-center justify-center gap-2 shadow-sm"
                >
                  <Edit2 size={16} />
                  Name Pages
                </button>
                <button
                  onClick={() => setShowAddPagesModal(true)}
                  className="flex-1 lg:flex-none px-4 py-2 bg-accent-600 text-white rounded-lg text-sm font-medium hover:bg-accent-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
                >
                  <Plus size={16} />
                  Add Pages
                </button>
              </div>
            </div>

            {filteredPages.length === 0 ? (
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-12 text-center">
                <div className="w-16 h-16 bg-slate-50 dark:bg-slate-900 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400 dark:text-slate-500">
                  <FileImage size={32} />
                </div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">No pages found</h3>
                <p className="text-slate-500 dark:text-slate-400 text-sm max-w-xs mx-auto">
                  {searchTerm ? `No pages match your search "${searchTerm}"` : 'This plan set has no pages yet. Add some to get started.'}
                </p>
                {!searchTerm && (
                  <button
                    onClick={() => setShowAddPagesModal(true)}
                    className="mt-6 px-4 py-2 text-accent-600 font-medium hover:bg-accent-50 rounded-lg transition-colors"
                  >
                    Add your first page
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredPages.map((page) => {
                  const isPageSelected = selectedPageIds.has(page.id);
                  return (
                  <Link
                    key={page.id}
                    to={`/project/${project.id}/page/${page.id}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                    state={{ pageIds: filteredPages.map(p => p.id) }}
                    className={`bg-white dark:bg-slate-800 rounded-xl border overflow-hidden hover:shadow-md transition-all flex flex-col group ${
                      isPageSelected
                        ? 'border-accent-500 shadow-md ring-2 ring-accent-400'
                        : 'border-slate-200 dark:border-slate-700 hover:border-accent-300 dark:hover:border-accent-500'
                    }`}
                  >
                    <div className="h-40 bg-slate-100 dark:bg-slate-700 relative overflow-hidden border-b border-slate-200 dark:border-slate-600">
                      <img
                        src={getImageUrl(page.thumbnailId || page.imageId)}
                        alt={page.name}
                        className="w-full h-full object-cover object-top opacity-90 group-hover:opacity-100 transition-opacity"
                        referrerPolicy="no-referrer"
                      />
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedPageIds(prev => {
                            const next = new Set(prev);
                            if (next.has(page.id)) next.delete(page.id);
                            else next.add(page.id);
                            return next;
                          });
                        }}
                        className={`absolute top-2 left-2 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                          isPageSelected
                            ? 'bg-accent-600 border-accent-600 opacity-100'
                            : 'bg-white/80 border-slate-300 opacity-0 group-hover:opacity-100'
                        }`}
                        title={isPageSelected ? 'Deselect' : 'Select'}
                      >
                        {isPageSelected && <Check size={14} className="text-white" />}
                      </button>
                    </div>
                    <div className="p-4 flex-1 flex flex-col justify-between">
                      <div>
                        {editingPageId === page.id ? (
                          <div className="flex flex-col gap-2 mb-2" onClick={e => e.preventDefault()}>
                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] font-bold text-slate-400 uppercase">Number</label>
                              <input
                                type="text"
                                value={editingPageNumber}
                                onChange={(e) => setEditingPageNumber(e.target.value)}
                                className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                                placeholder="e.g. A-01"
                                autoFocus
                                onClick={e => e.stopPropagation()}
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] font-bold text-slate-400 uppercase">Description</label>
                              <input
                                type="text"
                                value={editingPageDescription}
                                onChange={(e) => setEditingPageDescription(e.target.value)}
                                className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                                placeholder="e.g. Floor Plan"
                                onClick={e => e.stopPropagation()}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') handleSaveRenamePage(e as any, page.id);
                                  if (e.key === 'Escape') handleCancelRenamePage(e as any);
                                }}
                              />
                            </div>
                            <div className="flex justify-end gap-2 mt-1">
                              <button onClick={(e) => handleSaveRenamePage(e, page.id)} className="text-green-600 hover:bg-green-50 px-2 py-1 rounded text-xs font-bold flex items-center gap-1">
                                <Check size={14} /> Save
                              </button>
                              <button onClick={handleCancelRenamePage} className="text-slate-400 hover:bg-slate-100 px-2 py-1 rounded text-xs font-bold flex items-center gap-1">
                                <X size={14} /> Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between mb-1">
                            <h3 className="font-semibold text-slate-900 dark:text-slate-100 group-hover:text-accent-600 dark:group-hover:text-accent-400 transition-colors line-clamp-1">{page.name}</h3>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={(e) => { e.preventDefault(); handleSharePage(page); }}
                                className="text-slate-400 hover:text-accent-600 p-1 rounded hover:bg-accent-50"
                                title="Copy share link"
                              >
                                <LinkIcon size={14} />
                              </button>
                              <button
                                onClick={(e) => handleStartRenamePage(e, page)}
                                className="text-slate-400 hover:text-accent-600 p-1 rounded hover:bg-accent-50"
                              >
                                <Edit2 size={14} />
                              </button>
                            </div>
                          </div>
                        )}
                        <p className="text-sm text-slate-500">
                          {page.measurements.length} highlights
                        </p>
                        {searchTerm && page.extractedText && page.extractedText.toLowerCase().includes(searchTerm.toLowerCase()) && !page.name.toLowerCase().includes(searchTerm.toLowerCase()) && (
                          <div className="mt-2 text-xs text-slate-500 bg-slate-50 p-2 rounded border border-slate-100 line-clamp-2 italic">
                            ...{page.extractedText.substring(Math.max(0, page.extractedText.toLowerCase().indexOf(searchTerm.toLowerCase()) - 30), page.extractedText.toLowerCase().indexOf(searchTerm.toLowerCase()) + searchTerm.length + 30)}...
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                  );
                })}
              </div>
            )}
          </div>
        ) : activeTab === 'takeoffs' ? (
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">
            <div className="p-4 md:p-6 border-b border-slate-100 dark:border-slate-700 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-slate-800/50">
              <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Takeoffs Inventory</h2>
              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                {selectedTakeoffIds.size > 0 && (
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <select
                      value={highlightQuality}
                      onChange={e => setHighlightQuality(e.target.value as HighlightQuality)}
                      title="Blueprint print quality"
                      className="text-xs px-2 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 dark:text-white focus:ring-1 focus:ring-accent-500 outline-none transition-colors"
                    >
                      {(Object.entries(HIGHLIGHT_QUALITY_PRESETS) as [HighlightQuality, { label: string }][]).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={handlePrint}
                      disabled={isPrinting || isExportingExcel}
                      className="flex-1 sm:flex-none px-3 py-2 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                    >
                      {isPrinting ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                      Print ({selectedTakeoffIds.size})
                    </button>
                    <button
                      onClick={handleExportExcel}
                      disabled={isPrinting || isExportingExcel}
                      className="flex-1 sm:flex-none px-3 py-2 bg-accent-600 text-white rounded-lg text-xs font-medium hover:bg-accent-700 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                    >
                      {isExportingExcel ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
                      Excel ({selectedTakeoffIds.size})
                    </button>
                    <button
                      onClick={() => {
                        setProposalCustomTitle(project.name);
                        setProposalIncludeCostDetail(false);
                        setShowProposalModal(true);
                      }}
                      disabled={isGeneratingProposal}
                      className="flex-1 sm:flex-none px-3 py-2 bg-violet-600 text-white rounded-lg text-xs font-medium hover:bg-violet-700 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                    >
                      {isGeneratingProposal ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                      Proposal ({selectedTakeoffIds.size})
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  {project.takeoffs.length > 0 && (
                    <button
                      onClick={() => setShowDeleteAllConfirm(true)}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                      title="Delete All Takeoffs"
                    >
                      <Trash2 size={20} />
                    </button>
                  )}
                  <button
                    onClick={() => setShowTakeoffModal(true)}
                    className="flex-1 sm:flex-none px-4 py-2 bg-accent-600 text-white rounded-lg text-sm font-medium hover:bg-accent-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
                  >
                    <Plus size={16} />
                    New Takeoff
                  </button>
                </div>
              </div>
            </div>
            
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800 text-left text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest border-b border-slate-200 dark:border-slate-700">
                    <th className="px-6 py-4 w-10">
                      <input 
                        type="checkbox" 
                        className="rounded border-slate-300 dark:border-slate-600 text-accent-600 focus:ring-accent-500"
                        checked={selectedTakeoffIds.size === project.takeoffs.length && project.takeoffs.length > 0}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedTakeoffIds(new Set(project.takeoffs.map(t => t.id)));
                          } else {
                            setSelectedTakeoffIds(new Set());
                          }
                        }}
                      />
                    </th>
                    <th className="px-6 py-4">Takeoff</th>
                    <th className="px-6 py-4">Type</th>
                    <th className="px-6 py-4 text-right">Qty</th>
                    <th className="px-6 py-4 text-right">Unit Cost</th>
                    <th className="px-6 py-4 text-right">Total Cost</th>
                    <th className="px-6 py-4 w-24"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {(() => {
                    const totals = getTakeoffTotals();
                    const packageOrder: string[] = [];
                    const packageMap: Record<string, typeof totals> = {};
                    const ungrouped: typeof totals = [];
                    for (const t of totals) {
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
                    const renderRow = (takeoff: typeof totals[0]) => {
                      const totalCost = calculateTakeoffTotalCost(takeoff, takeoff.totalRealValue);
                      const costDetails = calculateTakeoffCostDetails(takeoff, takeoff.totalRealValue);
                      return (
                        <React.Fragment key={takeoff.id}>
                          <tr className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors group border-l-4" style={{ borderLeftColor: takeoff.color }}>
                            <td className="px-6 py-4">
                              <input
                                type="checkbox"
                                className="rounded border-slate-300 dark:border-slate-600 text-accent-600 focus:ring-accent-500"
                                checked={selectedTakeoffIds.has(takeoff.id)}
                                onChange={() => toggleTakeoffSelection(takeoff.id)}
                              />
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3 cursor-pointer" onClick={() => toggleTakeoffExpanded(takeoff.id)}>
                                <div className={`transition-transform duration-200 ${expandedTakeoffs[takeoff.id] ? 'rotate-90' : ''}`}>
                                  <ChevronRight size={16} className="text-slate-400" />
                                </div>
                                <div className="w-4 h-4 rounded-full shadow-sm shrink-0" style={{ backgroundColor: takeoff.color }} />
                                <span className="font-semibold text-slate-900 dark:text-slate-100">{takeoff.name}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-sm text-slate-500 dark:text-slate-400 capitalize font-medium">
                              {takeoff.type}
                            </td>
                            <td className="px-6 py-4 text-right font-bold text-slate-900 dark:text-slate-100">
                              {takeoff.totalRealValue > 0 ? formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                            </td>
                            <td className="px-6 py-4 text-right text-sm text-slate-600 dark:text-slate-400 font-medium">
                              {takeoff.isAdvancedCost ? (
                                <div className="flex flex-col items-end">
                                  <span className="text-accent-600 dark:text-accent-400 font-bold">${(totalCost / (takeoff.totalRealValue || 1)).toFixed(2)}</span>
                                  <span className="text-[10px] text-slate-400 uppercase">Avg / Unit</span>
                                </div>
                              ) : (
                                takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'
                              )}
                            </td>
                            <td className="px-6 py-4 text-right font-bold text-accent-600 dark:text-accent-400">
                              <div className="flex flex-col items-end">
                                <span>{totalCost > 0 ? `$${roundUpTo100(totalCost).toLocaleString()}` : '-'}</span>
                                {takeoff.isAdvancedCost && costDetails.map((d, i) => (
                                  d.quantity !== undefined && d.quantity > 0 && (
                                    <span key={i} className="text-[10px] text-slate-500 dark:text-slate-400 font-normal">
                                      {d.quantity.toFixed(2)} {d.quantityUnit || 'units'} of {d.name}
                                    </span>
                                  )
                                ))}
                              </div>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <div className="flex items-center justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={() => handleEditTakeoff(takeoff)}
                                  className="text-slate-400 hover:text-accent-600 p-2 rounded-lg hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors"
                                  title="Edit Takeoff"
                                >
                                  <Edit2 size={16} />
                                </button>
                                <button
                                  onClick={() => handleDeleteTakeoff(takeoff.id)}
                                  className="text-slate-400 hover:text-red-600 p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                                  title="Delete Takeoff"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                          {expandedTakeoffs[takeoff.id] && (
                            <tr>
                              <td colSpan={11} className="px-0 py-0 bg-slate-50/30 dark:bg-slate-800/30">
                                <div className="border-l-4 border-accent-500/20 ml-6 my-2 divide-y divide-slate-100 dark:divide-slate-700">
                                  {takeoff.pageBreakdown.map(pb => (
                                    <div key={pb.pageId} className="py-3 pl-8 pr-12 flex justify-between items-center hover:bg-white dark:hover:bg-slate-800 transition-colors">
                                      <Link
                                        to={`/project/${project.id}/page/${pb.pageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                                        state={{ pageIds: takeoff.pageBreakdown.map(p => p.pageId) }}
                                        className="text-sm text-accent-600 dark:text-accent-400 hover:text-accent-800 font-semibold flex items-center gap-2"
                                      >
                                        <FileImage size={14} className="text-slate-400" />
                                        {pb.pageName}
                                      </Link>
                                      <span className="text-sm font-bold text-slate-700 dark:text-slate-300">
                                        {formatRealValue(pb.realValue, takeoff.type as 'length' | 'area' | 'count', pb.unit?.replace('sq ', '') || 'ft', takeoff, false)}
                                      </span>
                                    </div>
                                  ))}
                                  {takeoff.pageBreakdown.length === 0 && (
                                    <div className="py-4 pl-8 text-sm text-slate-400 dark:text-slate-500 italic">No measurements found for this takeoff.</div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    };
                    return (
                      <>
                        {packageOrder.map(pkg => (
                          <React.Fragment key={`pkg-${pkg}`}>
                            <tr className="bg-slate-50/70 dark:bg-slate-800/70">
                              <td colSpan={7} className="px-6 py-2">
                                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">{pkg}</span>
                              </td>
                            </tr>
                            {packageMap[pkg].map(renderRow)}
                          </React.Fragment>
                        ))}
                        {ungrouped.map(renderRow)}
                      </>
                    );
                  })()}
                </tbody>
              </table>
            </div>

            {/* Mobile Takeoff Cards */}
            <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-700">
              {(() => {
                const totals = getTakeoffTotals();
                const packageOrder: string[] = [];
                const packageMap: Record<string, typeof totals> = {};
                const ungrouped: typeof totals = [];
                for (const t of totals) {
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
                const renderCard = (takeoff: typeof totals[0]) => {
                  const totalCost = calculateTakeoffTotalCost(takeoff, takeoff.totalRealValue);
                  return (
                    <div key={takeoff.id} className="p-4 bg-white dark:bg-slate-900 border-l-4" style={{ borderLeftColor: takeoff.color }}>
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            className="rounded border-slate-300 dark:border-slate-600 text-accent-600 focus:ring-accent-500"
                            checked={selectedTakeoffIds.has(takeoff.id)}
                            onChange={() => toggleTakeoffSelection(takeoff.id)}
                          />
                          <div className="w-3 h-3 rounded-full shadow-sm shrink-0" style={{ backgroundColor: takeoff.color }} />
                          <span className="font-bold text-slate-900 dark:text-slate-100">{takeoff.name}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleEditTakeoff(takeoff)}
                            className="p-1.5 text-slate-400 hover:text-accent-600"
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            onClick={() => handleDeleteTakeoff(takeoff.id)}
                            className="p-1.5 text-slate-400 hover:text-red-600"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-y-2 text-sm mb-3">
                        <div className="text-slate-500 dark:text-slate-400">Type</div>
                        <div className="text-slate-900 dark:text-slate-100 font-medium capitalize text-right">{takeoff.type}</div>

                        <div className="text-slate-500 dark:text-slate-400">Quantity</div>
                        <div className="text-slate-900 dark:text-slate-100 font-bold text-right">
                          {takeoff.totalRealValue > 0 ? formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                        </div>

                        <div className="text-slate-500 dark:text-slate-400">Total Cost</div>
                        <div className="text-accent-600 dark:text-accent-400 font-bold text-right">
                          {totalCost > 0 ? `$${roundUpTo100(totalCost).toLocaleString()}` : '-'}
                        </div>
                      </div>

                      <button
                        onClick={() => toggleTakeoffExpanded(takeoff.id)}
                        className="w-full py-2 bg-slate-50 dark:bg-slate-800 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center justify-center gap-2"
                      >
                        {expandedTakeoffs[takeoff.id] ? 'Hide' : 'Show'} Page Breakdown
                        <div className={`transition-transform duration-200 ${expandedTakeoffs[takeoff.id] ? 'rotate-90' : ''}`}>
                          <ChevronRight size={14} />
                        </div>
                      </button>

                      {expandedTakeoffs[takeoff.id] && (
                        <div className="mt-3 space-y-2 pt-3 border-t border-slate-100 dark:border-slate-700">
                          {takeoff.pageBreakdown.map(pb => (
                            <div key={pb.pageId} className="flex justify-between items-center text-xs">
                              <Link
                                to={`/project/${project.id}/page/${pb.pageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                                className="text-accent-600 dark:text-accent-400 font-medium"
                              >
                                {pb.pageName}
                              </Link>
                              <span className="font-bold text-slate-700 dark:text-slate-300">
                                {formatRealValue(pb.realValue, takeoff.type as 'length' | 'area' | 'count', pb.unit?.replace('sq ', '') || 'ft', takeoff, false)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                };
                return (
                  <>
                    {packageOrder.map(pkg => (
                      <React.Fragment key={`pkg-${pkg}`}>
                        <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800/70">
                          <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">{pkg}</span>
                        </div>
                        {packageMap[pkg].map(renderCard)}
                      </React.Fragment>
                    ))}
                    {ungrouped.map(renderCard)}
                  </>
                );
              })()}
            </div>

            {project.takeoffs.length === 0 && (
              <div className="px-6 py-12 text-center text-slate-500">
                No takeoffs created yet. <button onClick={() => setShowTakeoffModal(true)} className="text-accent-600 dark:text-accent-400 font-bold hover:underline">Create one</button> to start estimating.
              </div>
            )}
          </div>
        ) : activeTab === 'printouts' ? (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Generated Printouts</h2>
              <p className="text-sm text-slate-500">
                {project.printouts?.length || 0} files saved
              </p>
            </div>

            {(!project.printouts || project.printouts.length === 0) ? (
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-12 text-center">
                <div className="w-16 h-16 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400">
                  <Printer size={32} />
                </div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">No printouts yet</h3>
                <p className="text-slate-500 dark:text-slate-400 text-sm max-w-xs mx-auto">
                  Select takeoffs from the Takeoffs tab and click "Print PDF" or "Export Excel" to generate a report.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {[...(project.printouts || [])].sort((a, b) => b.createdAt - a.createdAt).map((printout) => (
                  <div key={printout.id} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden hover:shadow-md transition-all group">
                    <div className="p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div className={`w-12 h-12 ${printout.type === 'excel' ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600' : 'bg-accent-50 dark:bg-accent-900/30 text-accent-600'} rounded-xl flex items-center justify-center`}>
                          {printout.type === 'excel' ? <FileSpreadsheet size={24} /> : <FileText size={24} />}
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleSharePrintout(printout)}
                            className="p-2 text-slate-400 hover:text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-900/30 rounded-lg transition-colors"
                            title="Copy share link"
                          >
                            <LinkIcon size={18} />
                          </button>
                          <button
                            onClick={() => handleViewPrintout(printout)}
                            className="p-2 text-slate-400 hover:text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-900/30 rounded-lg transition-colors"
                            title={printout.type === 'excel' ? "Open in Spreadsheet Editor" : "View PDF"}
                          >
                            <Eye size={18} />
                          </button>
                          <button
                            onClick={() => handleDownloadPrintout(printout)}
                            className="p-2 text-slate-400 hover:text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-900/30 rounded-lg transition-colors"
                            title={printout.type === 'excel' ? "Download Excel" : "Download PDF"}
                          >
                            <Download size={18} />
                          </button>
                          <button 
                            onClick={() => handleDeletePrintout(printout.id)}
                            className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                            title="Delete Printout"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </div>
                      <h3 className="font-semibold text-slate-900 dark:text-slate-100 mb-1 line-clamp-1">{printout.name}</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Generated on {new Date(printout.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          /* Email tab — only reachable when project.email exists */
          project.email ? (
            <div className="space-y-4 max-w-3xl">
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-5">
                <div className="flex items-start gap-3 mb-4">
                  <div className="p-2 rounded-lg bg-accent-50 dark:bg-accent-900/30 shrink-0">
                    <Mail size={18} className="text-accent-600 dark:text-accent-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-slate-900 dark:text-white leading-tight">{project.email.subject}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                      <span className="font-medium text-slate-700 dark:text-slate-300">{project.email.fromName || project.email.from}</span>
                      {project.email.fromName && <span className="text-slate-400"> &lt;{project.email.from}&gt;</span>}
                      <span className="ml-2">{new Date(project.email.receivedAt).toLocaleString()}</span>
                    </p>
                  </div>
                  <button
                    onClick={() => { setSendProposalFileId(''); setSendProposalMessage(''); setShowSendProposalModal(true); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-600 text-white text-xs font-medium hover:bg-accent-700 transition-all shrink-0"
                  >
                    <Send size={13} /> Send Proposal
                  </button>
                </div>

                {project.proposalSentAt && (
                  <div className="mb-4 px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 text-xs text-emerald-700 dark:text-emerald-300">
                    Proposal sent {new Date(project.proposalSentAt).toLocaleString()}
                  </div>
                )}

                {(() => {
                  const thread = project.emails && project.emails.length > 0
                    ? [...project.emails].reverse() // newest first
                    : project.email ? [project.email] : [];
                  return (
                    <div className="space-y-2">
                      {thread.map((em, idx) => {
                        const isLatest = idx === 0;
                        const isOpen = isLatest || expandedThreadKeys.has(idx);
                        const toggle = () => setExpandedThreadKeys(s => {
                          const n = new Set(s); isOpen ? n.delete(idx) : n.add(idx); return n;
                        });
                        return (
                          <div key={idx} className="rounded-xl border border-slate-200 dark:border-slate-600 overflow-hidden">
                            <button onClick={toggle} className={`w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors ${isLatest ? 'bg-accent-50 dark:bg-accent-900/20' : 'bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-700/60'}`}>
                              <span className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                                {em.fromName || em.from}
                                {em.fromName && <span className="ml-1 text-slate-400 font-normal text-xs">&lt;{em.from}&gt;</span>}
                              </span>
                              <span className="flex items-center gap-2 shrink-0 ml-3">
                                <span className="text-xs text-slate-400">{new Date(em.receivedAt).toLocaleDateString()}</span>
                                {isOpen ? <ChevronUp size={13} className="text-slate-400" /> : <ChevronDown size={13} className="text-slate-400" />}
                              </span>
                            </button>
                            {isOpen && (
                              <div className="border-t border-slate-100 dark:border-slate-700">
                                {em.htmlBody ? (
                                  <iframe
                                    srcDoc={em.htmlBody}
                                    sandbox="allow-same-origin allow-popups"
                                    title="Email content"
                                    className="w-full bg-white"
                                    style={{ minHeight: 120 }}
                                    onLoad={e => {
                                      const frame = e.currentTarget;
                                      try {
                                        const doc = frame.contentDocument;
                                        if (!doc) return;
                                        const h = doc.documentElement?.scrollHeight;
                                        if (h && h > 0) frame.style.height = h + 16 + 'px';
                                        doc.querySelectorAll('a[href]').forEach(a => {
                                          (a as HTMLAnchorElement).target = '_blank';
                                          (a as HTMLAnchorElement).rel = 'noopener noreferrer';
                                        });
                                      } catch {}
                                    }}
                                  />
                                ) : (
                                  <p className="px-4 py-3 text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{em.body}</p>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            </div>
          ) : null
        )}
      </div>

      {/* Send Proposal Modal */}
      {showSendProposalModal && project.email && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl w-full max-w-xl">
            <div className="p-6 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2"><Send size={20} className="text-accent-600" /> Send Proposal</h3>
              <button onClick={() => setShowSendProposalModal(false)} className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-all"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-3 text-sm">
                <p className="text-slate-500 dark:text-slate-400 text-xs uppercase font-bold tracking-wider mb-1">Replying to</p>
                <p className="font-semibold text-slate-800 dark:text-slate-200">{project.email.fromName || project.email.from}</p>
                <p className="text-slate-500 dark:text-slate-400 text-xs">{project.email.from} · Re: {project.email.subject}</p>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">Attach Proposal</label>
                <select className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white text-sm outline-none focus:ring-2 focus:ring-accent-500"
                  value={sendProposalFileId} onChange={e => setSendProposalFileId(e.target.value)}>
                  <option value="">— Select a printout —</option>
                  {(project.printouts || []).filter(pr => pr.type === 'pdf').map(pr => (
                    <option key={pr.fileId} value={pr.fileId}>{pr.name}</option>
                  ))}
                </select>
                {!(project.printouts || []).some(pr => pr.type === 'pdf') && (
                  <p className="mt-1.5 text-xs text-slate-400">No PDF printouts on this project yet. Generate one from the Takeoffs tab.</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">Message <span className="font-normal text-slate-400 normal-case">(optional)</span></label>
                <textarea rows={4} className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white text-sm outline-none focus:ring-2 focus:ring-accent-500 resize-none" value={sendProposalMessage} onChange={e => setSendProposalMessage(e.target.value)} placeholder="Please find our proposal attached. Don't hesitate to reach out with any questions." />
              </div>
            </div>
            <div className="p-6 pt-0 flex justify-end gap-3">
              <button onClick={() => setShowSendProposalModal(false)} className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-600 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all">Cancel</button>
              <button
                onClick={async () => {
                  if (!sendProposalFileId || !project) return;
                  setSendingProposal(true);
                  try {
                    const updated = await sendProjectProposal(project.id, sendProposalFileId, sendProposalMessage || undefined);
                    setProject(updated);
                    setShowSendProposalModal(false);
                    setSendProposalFileId('');
                    setSendProposalMessage('');
                  } catch (e: any) {
                    alert('Failed to send: ' + (e.message || 'Unknown error'));
                  } finally {
                    setSendingProposal(false);
                  }
                }}
                disabled={sendingProposal || !sendProposalFileId}
                className="px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50 flex items-center gap-2"
              >
                {sendingProposal ? <><RefreshCw size={15} className="animate-spin" /> Sending…</> : <><Send size={15} /> Send</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteAllConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900 text-red-600">Delete All Takeoffs</h3>
            </div>
            <div className="p-6">
              <p className="text-slate-600">
                Are you sure you want to delete ALL takeoffs in this project? This will ungroup all measurements. This action is permanent and cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteAllConfirm(false)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteAllTakeoffs}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Delete Takeoff</h3>
            </div>
            <div className="p-6">
              <p className="text-slate-600">
                Are you sure you want to delete this takeoff? All measurements associated with it will be ungrouped. This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setTakeoffToDelete(null); }}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteTakeoff}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete Takeoff
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeletePrintoutConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Delete Printout</h3>
            </div>
            <div className="p-6">
              <p className="text-slate-600">
                Are you sure you want to delete this printout? This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => { setShowDeletePrintoutConfirm(false); setPrintoutToDelete(null); }}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeletePrintout}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete Printout
              </button>
            </div>
          </div>
        </div>
      )}

      <NewTakeoffModal
        open={showTakeoffModal}
        onClose={() => setShowTakeoffModal(false)}
        project={project}
        templates={templates}
        onCreateTakeoff={async (newTakeoff) => {
          const updatedProject = {
            ...project,
            takeoffs: [...project.takeoffs, newTakeoff],
          };
          await saveProject(updatedProject);
          setProject(updatedProject);
          setShowTakeoffModal(false);
        }}
      />

      {editingTakeoff && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Edit Measurement Takeoff</h3>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Takeoff Name</label>
                <input
                  type="text"
                  value={editTakeoffName}
                  onChange={(e) => setEditTakeoffName(e.target.value)}
                  className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
                  placeholder="e.g. Hardwood Flooring"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Price Package <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  list="price-package-options-edit"
                  value={editTakeoffPricePackage}
                  onChange={(e) => setEditTakeoffPricePackage(e.target.value)}
                  className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
                  placeholder="e.g. Flooring Package"
                />
                <datalist id="price-package-options-edit">
                  {Array.from(new Set(project.takeoffs.map(t => t.pricePackage).filter(Boolean))).map(pkg => (
                    <option key={pkg} value={pkg} />
                  ))}
                </datalist>
                <p className="mt-1 text-xs text-slate-400">Takeoffs with the same package name are grouped together.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Measurement Type</label>
                  <input
                    type="text"
                    value={editingTakeoff.type}
                    disabled
                    className="w-full border border-slate-200 rounded-xl px-4 py-2.5 bg-slate-50 text-slate-500 capitalize"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={editTakeoffColor}
                      onChange={(e) => setEditTakeoffColor(e.target.value)}
                      className="h-11 w-full rounded-lg cursor-pointer border border-slate-300 p-1"
                    />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Unit</label>
                  <select
                    value={editTakeoffUnit}
                    onChange={(e) => setEditTakeoffUnit(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-white"
                  >
                    <option value="">Default (Scale Unit)</option>
                    {editingTakeoff.type === 'length' && (
                      <>
                        <option value="in">Inches (in)</option>
                        <option value="ft">Feet (ft)</option>
                        <option value="yd">Yards (yd)</option>
                        <option value="cm">Centimeters (cm)</option>
                        <option value="m">Meters (m)</option>
                      </>
                    )}
                    {editingTakeoff.type === 'area' && (
                      <>
                        <option value="sqin">Square Inches (sq in)</option>
                        <option value="sqft">Square Feet (sq ft)</option>
                        <option value="sqyd">Square Yards (sq yd)</option>
                        <option value="sqcm">Square Centimeters (sq cm)</option>
                        <option value="sqm">Square Meters (sq m)</option>
                      </>
                    )}
                    {editingTakeoff.type === 'count' && (
                      <option value="each">Each</option>
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Cost Per Unit ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    disabled={isEditTakeoffAdvanced}
                    value={isEditTakeoffAdvanced ? '' : editTakeoffCostPerUnit}
                    onChange={(e) => setEditTakeoffCostPerUnit(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 disabled:bg-slate-50 disabled:text-slate-400"
                    placeholder={isEditTakeoffAdvanced ? "Disabled in Advanced" : "0.00"}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 py-2">
                <input
                  type="checkbox"
                  id="isEditTakeoffAdvanced"
                  checked={isEditTakeoffAdvanced}
                  onChange={(e) => setIsEditTakeoffAdvanced(e.target.checked)}
                  className="w-4 h-4 text-accent-600 rounded border-slate-300 focus:ring-accent-500"
                />
                <label htmlFor="isEditTakeoffAdvanced" className="text-sm font-medium text-slate-700 cursor-pointer">
                  Advanced Costing (Custom Items)
                </label>
              </div>

              {isEditTakeoffAdvanced && (
                <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="flex justify-between items-center mb-2">
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Custom Cost Items</h4>
                    <button
                      onClick={() => setEditTakeoffCustomCosts([...editTakeoffCustomCosts, { id: uuidv4(), name: '', type: 'unit', costPerUnit: 0 }])}
                      className="text-accent-600 hover:text-accent-700 p-1 rounded-full hover:bg-accent-50 transition-colors"
                      title="Add Cost Item"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  
                  {editTakeoffCustomCosts.length === 0 ? (
                    <p className="text-xs text-slate-400 italic text-center py-2">No custom items added. Click + to add.</p>
                  ) : (
                    <div className="space-y-3">
                      {editTakeoffCustomCosts.map((item, index) => (
                        <CustomCostRow
                          key={item.id}
                          item={item}
                          index={index}
                          unitLabel={UNIT_LABELS[editTakeoffUnit] || editTakeoffUnit || (editingTakeoff?.type === 'area' ? 'sq ft' : editingTakeoff?.type === 'length' ? 'ft' : 'ea')}
                          onChange={(idx, updated) => {
                            const newCosts = [...editTakeoffCustomCosts];
                            newCosts[idx] = updated;
                            setEditTakeoffCustomCosts(newCosts);
                          }}
                          onRemove={(idx) => {
                            setEditTakeoffCustomCosts(editTakeoffCustomCosts.filter((_, i) => i !== idx));
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setEditingTakeoff(null)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEditTakeoff}
                disabled={!editTakeoffName}
                className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddPagesModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className={`bg-white rounded-2xl shadow-xl w-full ${addPagesStep === 'name_pages' ? 'max-w-4xl' : 'max-w-md'} overflow-hidden flex flex-col max-h-[90vh]`}>
            <div className="p-6 border-b border-slate-100 flex justify-between items-center">
              <div>
                <h3 className="text-xl font-bold text-slate-900">
                  {addPagesStep === 'details' ? 'Add New Plan Set' : 'Name Pages'}
                </h3>
                <p className="text-sm text-slate-500 mt-1">
                  {addPagesStep === 'details' ? 'Upload a revised or new set of blueprints' : 'Review and rename the imported pages'}
                </p>
              </div>
              <button 
                onClick={() => {
                  setShowAddPagesModal(false);
                  setAddPagesStep('details');
                  setIsNamingExistingPages(false);
                  setNewPlanSetName('');
                  setNewPlanSetFiles([]);
                  setPendingPages([]);
                  setPendingThumbnails({});
                  setUseExistingPlanSet(false);
                  setTargetPlanSetId('');
                }}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            
            {addPagesStep === 'details' ? (
              <form onSubmit={handleAddPages} className="flex flex-col overflow-hidden">
                <div className="p-6 space-y-5 overflow-y-auto">
                  <div className="flex items-center gap-4 p-1 bg-slate-100 rounded-lg w-fit mb-2">
                    <button
                      type="button"
                      onClick={() => setUseExistingPlanSet(false)}
                      className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${!useExistingPlanSet ? 'bg-white text-accent-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      New Plan Set
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUseExistingPlanSet(true);
                        if (project.planSets && project.planSets.length > 0 && !targetPlanSetId) {
                          setTargetPlanSetId(project.planSets[0].id);
                        }
                      }}
                      className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${useExistingPlanSet ? 'bg-white text-accent-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      Existing Plan Set
                    </button>
                  </div>

                  {useExistingPlanSet ? (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">Select Plan Set</label>
                      <select
                        value={targetPlanSetId}
                        onChange={(e) => setTargetPlanSetId(e.target.value)}
                        className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-white"
                        required
                      >
                        {project.planSets?.map(ps => (
                          <option key={ps.id} value={ps.id}>{ps.name} ({new Date(ps.date).toLocaleDateString()})</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">Plan Set Name</label>
                        <input
                          type="text"
                          value={newPlanSetName}
                          onChange={(e) => setNewPlanSetName(e.target.value)}
                          className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
                          placeholder="e.g. Revised Floor Plan"
                          required={!useExistingPlanSet}
                          disabled={isAddingPages}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">Plan Set Date</label>
                        <input
                          type="date"
                          value={newPlanSetDate}
                          onChange={(e) => setNewPlanSetDate(e.target.value)}
                          className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
                          required={!useExistingPlanSet}
                          disabled={isAddingPages}
                        />
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Blueprint PDFs</label>
                    <div 
                      className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
                        newPlanSetFiles.length > 0 ? 'border-accent-300 bg-accent-50' : 'border-slate-300 hover:border-accent-400 bg-slate-50 hover:bg-slate-100 cursor-pointer'
                      }`}
                      onClick={() => !isAddingPages && newPlanSetFiles.length === 0 && fileInputRef.current?.click()}
                    >
                      {newPlanSetFiles.length > 0 ? (
                        <div className="flex flex-col items-center w-full">
                          <div className="w-full space-y-2 mb-3">
                            {newPlanSetFiles.map((file, index) => (
                              <div key={`${file.name}-${index}`} className="flex items-center justify-between bg-white p-2 rounded-lg border border-accent-200 shadow-sm">
                                <div className="flex items-center gap-2 overflow-hidden">
                                  <FileImage size={16} className="text-accent-500 shrink-0" />
                                  <div className="text-left overflow-hidden">
                                    <p className="text-xs font-medium text-slate-900 truncate" title={file.name}>{file.name}</p>
                                  </div>
                                </div>
                                {!isAddingPages && (
                                  <button 
                                    type="button" 
                                    onClick={(e) => { e.stopPropagation(); removeNewPlanSetFile(index); }}
                                    className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors shrink-0"
                                    title="Remove file"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                          {!isAddingPages && (
                            <button 
                              type="button" 
                              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                              className="mt-1 text-sm text-accent-600 hover:text-accent-700 font-medium flex items-center gap-1"
                            >
                              <Plus size={14} /> Add more PDFs
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center">
                          <Upload size={32} className="text-slate-400 mb-2" />
                          <p className="text-sm font-medium text-slate-900">Click to select PDFs</p>
                        </div>
                      )}
                    </div>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={(e) => {
                        const selectedFiles = Array.from(e.target.files || []);
                        if (selectedFiles.length > 0) {
                          setNewPlanSetFiles(prev => [...prev, ...selectedFiles]);
                          if (!newPlanSetName) {
                            setNewPlanSetName(selectedFiles[0].name.replace('.pdf', ''));
                          }
                        }
                      }}
                      accept="application/pdf"
                      className="hidden"
                      multiple
                      required={newPlanSetFiles.length === 0}
                      disabled={isAddingPages}
                    />
                  </div>
                </div>
                <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddPagesModal(false);
                      setIsNamingExistingPages(false);
                      setNewPlanSetName('');
                      setNewPlanSetFiles([]);
                      setUseExistingPlanSet(false);
                      setTargetPlanSetId('');
                    }}
                    disabled={isAddingPages}
                    className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={(!newPlanSetName && !useExistingPlanSet) || (useExistingPlanSet && !targetPlanSetId) || newPlanSetFiles.length === 0 || isAddingPages}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
                  >
                    {isAddingPages ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        {addProgress.status ? `${addProgress.status} ` : 'Adding '}
                        {addProgress.totalFiles > 1 ? `File ${addProgress.currentFile}/${addProgress.totalFiles} ` : ''}
                        {addProgress.total > 0 ? `(${addProgress.current}/${addProgress.total})` : '...'}
                      </>
                    ) : (
                      'Next Step'
                    )}
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex flex-col overflow-hidden">
                <div className="p-6 overflow-y-auto">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {pendingPages.map((page, index) => (
                      <div key={page.id} className="bg-white rounded-2xl border-2 border-slate-100 overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-all duration-300">
                        {/* Thumbnail Section */}
                        <div 
                          className="h-48 bg-slate-100 relative flex-shrink-0 border-b border-slate-100 cursor-pointer overflow-hidden group"
                          onClick={() => setPreviewPageId(page.id)}
                        >
                          {pendingThumbnails[page.imageId] ? (
                            <img 
                              src={pendingThumbnails[page.imageId]} 
                              alt={`Page ${index + 1}`}
                              className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-110"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-400">
                              <Loader2 size={32} className="animate-spin" />
                            </div>
                          )}
                          
                          {/* Hover Overlay */}
                          <div className="absolute inset-0 bg-accent-600/0 group-hover:bg-accent-600/40 transition-all duration-300 flex flex-col items-center justify-center gap-3">
                            <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white opacity-0 group-hover:opacity-100 scale-50 group-hover:scale-100 transition-all duration-300">
                              <Eye size={24} />
                            </div>
                            <span className="text-white text-[10px] font-black uppercase tracking-[0.2em] opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0">
                              Click to Preview
                            </span>
                          </div>

                          {/* Page Badge */}
                          <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-md text-accent-600 text-[10px] font-black px-2.5 py-1.5 rounded-lg shadow-sm border border-accent-100">
                            PAGE {index + 1}
                          </div>
                          {/* Revision badge */}
                          {page.revisionOf && (
                            <div className="absolute top-3 right-3 bg-amber-500/90 backdrop-blur-md text-white text-[9px] font-black px-2 py-1.5 rounded-lg shadow-sm">
                              REVISION
                            </div>
                          )}
                        </div>

                        {/* Input Section */}
                        <div className="p-5 space-y-5">
                          <div className="space-y-2">
                            <div className="flex items-center justify-between px-1">
                              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Page Number</label>
                              {page.pageNumber && <Check size={12} className="text-green-500" />}
                            </div>
                            <div className="relative">
                              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                                <Hash size={14} />
                              </div>
                              <input
                                type="text"
                                value={page.pageNumber || ''}
                                onChange={(e) => updatePendingPageField(page.id, 'pageNumber', e.target.value)}
                                className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-slate-100 bg-slate-50 focus:bg-white focus:border-accent-500 focus:ring-4 focus:ring-accent-500/10 outline-none transition-all text-sm font-bold text-slate-800 placeholder:text-slate-300 placeholder:font-normal"
                                placeholder="e.g. A-101"
                              />
                            </div>
                            {page.revisionOf && (
                              <p className="text-[10px] text-amber-600 font-medium px-1">
                                Replaces existing page {page.revisionOf} — measurements on the previous version will be hidden when this set is active
                              </p>
                            )}
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between px-1">
                              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Description</label>
                              {page.description && <Check size={12} className="text-green-500" />}
                            </div>
                            <div className="relative">
                              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                                <FileText size={14} />
                              </div>
                              <input
                                type="text"
                                value={page.description || ''}
                                onChange={(e) => updatePendingPageField(page.id, 'description', e.target.value)}
                                className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-slate-100 bg-slate-50 focus:bg-white focus:border-accent-500 focus:ring-4 focus:ring-accent-500/10 outline-none transition-all text-sm font-bold text-slate-800 placeholder:text-slate-300 placeholder:font-normal"
                                placeholder="e.g. Floor Plan"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-between items-center">
                  {isNamingExistingPages ? (
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddPagesModal(false);
                        setIsNamingExistingPages(false);
                        setPendingPages([]);
                        setPendingThumbnails({});
                      }}
                      disabled={isAddingPages}
                      className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors font-medium"
                    >
                      <X size={16} />
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAddPagesStep('details')}
                      disabled={isAddingPages}
                      className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors font-medium"
                    >
                      <ArrowLeft size={16} />
                      Back
                    </button>
                  )}
                  <button
                    onClick={handleConfirmAddPages}
                    disabled={isAddingPages}
                    className="flex items-center gap-2 px-6 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
                  >
                    {isAddingPages ? (
                      <><Loader2 size={16} className="animate-spin" /> Saving...</>
                    ) : (
                      <><Check size={16} /> {isNamingExistingPages ? 'Save Changes' : 'Add Pages'}</>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {previewPageId && (
        <div className="fixed inset-0 bg-slate-900/90 backdrop-blur-md flex items-center justify-center z-[70] p-4 sm:p-8">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl h-full flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => setPreviewPageId(null)}
                  className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                >
                  <ArrowLeft size={20} />
                </button>
                <h3 className="font-bold text-slate-900">Page Preview & Extraction</h3>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center bg-white border border-slate-200 rounded-lg p-1 mr-2">
                  <button 
                    onClick={() => setZoom(prev => Math.max(1, prev - 0.5))}
                    className="p-1.5 hover:bg-slate-100 rounded text-slate-600 transition-colors"
                    title="Zoom Out"
                  >
                    <ZoomOut size={16} />
                  </button>
                  <span className="text-xs font-bold text-slate-500 w-12 text-center">{Math.round(zoom * 100)}%</span>
                  <button 
                    onClick={() => setZoom(prev => Math.min(5, prev + 0.5))}
                    className="p-1.5 hover:bg-slate-100 rounded text-slate-600 transition-colors"
                    title="Zoom In"
                  >
                    <ZoomIn size={16} />
                  </button>
                  <button 
                    onClick={() => { setZoom(1); setPanOffset({ x: 0, y: 0 }); }}
                    className="p-1.5 hover:bg-slate-100 rounded text-slate-600 transition-colors ml-1 border-l border-slate-100"
                    title="Reset Zoom"
                  >
                    <Maximize size={16} />
                  </button>
                </div>

                <button
                  onClick={() => setExtractionType('pageNumber')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${extractionType === 'pageNumber' ? 'bg-accent-600 text-white shadow-md' : 'bg-white text-slate-600 border border-slate-200 hover:border-accent-300'}`}
                >
                  Extract Number
                </button>
                <button
                  onClick={() => setExtractionType('description')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${extractionType === 'description' ? 'bg-accent-600 text-white shadow-md' : 'bg-white text-slate-600 border border-slate-200 hover:border-accent-300'}`}
                >
                  Extract Description
                </button>
                <div className="w-px h-6 bg-slate-200 mx-2" />
                <button 
                  onClick={() => setPreviewPageId(null)}
                  className="p-2 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <X size={24} />
                </button>
              </div>
            </div>
            
            <div
              className={`flex-grow overflow-hidden relative bg-slate-800 flex items-center justify-center ${isPanning ? 'cursor-grabbing' : extractionType ? 'cursor-crosshair' : zoom > 1 ? 'cursor-grab' : 'cursor-default'}`}
              onWheel={(e) => {
                e.preventDefault();
                const zoomDirection = e.deltaY > 0 ? -1 : 1;
                const zoomFactor = 1.15;
                const newZoom = Math.min(5, Math.max(1, zoomDirection > 0 ? zoom * zoomFactor : zoom / zoomFactor));
                if (newZoom === zoom) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const mouseX = e.clientX - (rect.left + rect.width / 2);
                const mouseY = e.clientY - (rect.top + rect.height / 2);
                const scaleRatio = newZoom / zoom;
                const nextOffset = newZoom === 1
                  ? { x: 0, y: 0 }
                  : { x: mouseX - (mouseX - panOffset.x) * scaleRatio, y: mouseY - (mouseY - panOffset.y) * scaleRatio };
                setPanOffset(nextOffset);
                setZoom(newZoom);
              }}
              onMouseDown={(e) => {
                // Middle mouse button pans, regardless of zoom level or extraction mode.
                if (e.button === 1) {
                  e.preventDefault();
                  setIsPanning(true);
                  setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
                }
              }}
              onMouseMove={(e) => {
                if (isPanning) {
                  setPanOffset({
                    x: e.clientX - panStart.x,
                    y: e.clientY - panStart.y
                  });
                  return;
                }

                const rect = imageContainerRef.current?.getBoundingClientRect();
                if (!rect) return;

                if (interactionMode === 'move' && initialRect && selectionStart) {
                  const dx = ((e.clientX - selectionStart.x) / rect.width) * 100;
                  const dy = ((e.clientY - selectionStart.y) / rect.height) * 100;
                  setExtractionRect({
                    ...initialRect,
                    x: Math.max(0, Math.min(100 - initialRect.width, initialRect.x + dx)),
                    y: Math.max(0, Math.min(100 - initialRect.height, initialRect.y + dy))
                  });
                  return;
                }

                if (interactionMode && interactionMode.startsWith('resize-') && initialRect && selectionStart) {
                  // The opposite corner stays anchored; only the dragged edges move.
                  const anchorX = interactionMode.includes('w') ? initialRect.x + initialRect.width : initialRect.x;
                  const anchorY = interactionMode.includes('n') ? initialRect.y + initialRect.height : initialRect.y;
                  const cursorX = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
                  const cursorY = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));

                  let { x: newX, y: newY, width: newW, height: newH } = initialRect;
                  if (interactionMode.includes('w') || interactionMode.includes('e')) {
                    newX = Math.min(cursorX, anchorX);
                    newW = Math.max(0.5, Math.abs(cursorX - anchorX));
                  }
                  if (interactionMode.includes('n') || interactionMode.includes('s')) {
                    newY = Math.min(cursorY, anchorY);
                    newH = Math.max(0.5, Math.abs(cursorY - anchorY));
                  }
                  setExtractionRect({ x: newX, y: newY, width: newW, height: newH });
                  return;
                }

                if (isSelecting && selectionStart && interactionMode === 'draw') {
                  const clientX = Math.max(rect.left, Math.min(rect.right, e.clientX));
                  const clientY = Math.max(rect.top, Math.min(rect.bottom, e.clientY));

                  const x = ((clientX - rect.left) / rect.width) * 100;
                  const y = ((clientY - rect.top) / rect.height) * 100;

                  setExtractionRect({
                    x: Math.min(x, selectionStart.x),
                    y: Math.min(y, selectionStart.y),
                    width: Math.abs(x - selectionStart.x),
                    height: Math.abs(y - selectionStart.y)
                  });
                }
              }}
              onMouseUp={() => {
                setIsSelecting(false);
                setIsPanning(false);
                setInteractionMode(null);
              }}
              onMouseLeave={() => {
                setIsSelecting(false);
                setIsPanning(false);
                setInteractionMode(null);
              }}
            >
              <div
                ref={imageContainerRef}
                className="relative transition-transform duration-200 ease-out"
                style={{
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                  transformOrigin: 'center center'
                }}
                onMouseDown={(e) => {
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
                }}
              >
                <img
                  src={getImageUrl(pendingPages.find(p => p.id === previewPageId)?.imageId || '')}
                  alt="Preview"
                  className="max-w-full max-h-[80vh] object-contain select-none shadow-2xl"
                  draggable={false}
                />
                {extractionRect && (
                  <div
                    className="absolute border-accent-500 bg-accent-500/10 cursor-move pointer-events-auto"
                    style={{
                      left: `${extractionRect.x}%`,
                      top: `${extractionRect.y}%`,
                      width: `${extractionRect.width}%`,
                      height: `${extractionRect.height}%`,
                      borderStyle: 'solid',
                      borderWidth: `${1 / zoom}px`,
                    }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      setInteractionMode('move');
                      setSelectionStart({ x: e.clientX, y: e.clientY });
                      setInitialRect({ ...extractionRect });
                    }}
                  >
                    {([
                      { mode: 'resize-nw', pos: 'top-0 left-0', tx: '-50%', ty: '-50%', cursor: 'nwse-resize' },
                      { mode: 'resize-ne', pos: 'top-0 right-0', tx: '50%', ty: '-50%', cursor: 'nesw-resize' },
                      { mode: 'resize-sw', pos: 'bottom-0 left-0', tx: '-50%', ty: '50%', cursor: 'nesw-resize' },
                      { mode: 'resize-se', pos: 'bottom-0 right-0', tx: '50%', ty: '50%', cursor: 'nwse-resize' },
                    ] as const).map(h => (
                      <div
                        key={h.mode}
                        className={`absolute ${h.pos} flex items-center justify-center`}
                        style={{ width: 22, height: 22, transform: `translate(${h.tx}, ${h.ty}) scale(${1 / zoom})`, cursor: h.cursor }}
                        onMouseDown={(e) => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          e.stopPropagation();
                          setInteractionMode(h.mode);
                          setSelectionStart({ x: e.clientX, y: e.clientY });
                          setInitialRect({ ...extractionRect });
                        }}
                      >
                        <div className="w-2.5 h-2.5 rounded-[2px] bg-white border border-accent-600 shadow" />
                      </div>
                    ))}
                  </div>
                )}
                {!extractionType && zoom === 1 && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="bg-black/60 text-white px-6 py-3 rounded-xl backdrop-blur-md text-sm font-medium text-center">
                      Pick "Extract Number" or "Extract Description", then drag a box around the text.<br />
                      <span className="text-white/70 text-xs">Scroll to zoom · middle-mouse drag to pan</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-between items-center">
              <div className="flex items-center gap-2 text-sm text-slate-600">
                {extractionRect ? (
                  <>
                    <div className="w-2 h-2 rounded-full bg-accent-500 animate-pulse" />
                    Area selected. Ready to extract {extractionType === 'pageNumber' ? 'page number' : 'description'}.
                  </>
                ) : (
                  <>
                    <div className="w-2 h-2 rounded-full bg-slate-300" />
                    Select an area to extract text.
                  </>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setExtractionRect(null)}
                  disabled={!extractionRect}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  Clear Selection
                </button>
                <button
                  onClick={() => handleExtractText(false)}
                  disabled={isExtracting || !extractionRect}
                  className="px-6 py-2 bg-slate-800 text-white rounded-lg text-sm font-bold hover:bg-slate-900 transition-all flex items-center gap-2 disabled:opacity-50"
                >
                  {isExtracting ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                  Extract Current
                </button>
                <button
                  onClick={() => handleExtractText(true)}
                  disabled={isExtracting || !extractionRect}
                  className="px-6 py-2 bg-accent-600 text-white rounded-lg text-sm font-bold hover:bg-accent-700 transition-all flex items-center gap-2 shadow-lg shadow-accent-200 disabled:opacity-50"
                >
                  {isExtracting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  Extract All Pages
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Proposal PDF Modal */}
      {showProposalModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 dark:border-slate-700 flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex items-center gap-3 flex-shrink-0">
              <div className="p-2 bg-violet-50 dark:bg-violet-900/30 rounded-lg">
                <FileText size={20} className="text-violet-600 dark:text-violet-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">Generate Proposal PDF</h2>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {selectedTakeoffIds.size} takeoff{selectedTakeoffIds.size !== 1 ? 's' : ''} selected
                </p>
              </div>
            </div>
            <div className="p-6 space-y-5 overflow-y-auto flex-1 min-h-0">
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                  Proposal Title
                </label>
                <input
                  type="text"
                  value={proposalCustomTitle}
                  onChange={e => setProposalCustomTitle(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-violet-500 outline-none transition-all"
                  placeholder={project.name}
                />
              </div>
              {/* Header color */}
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Header Color</label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={proposalHeaderColor}
                    onChange={e => setProposalHeaderColor(e.target.value)}
                    className="h-10 w-14 rounded-lg cursor-pointer border border-slate-300 dark:border-slate-600 p-0.5 bg-white dark:bg-slate-800"
                  />
                  <span className="text-sm text-slate-500 dark:text-slate-400 font-mono">{proposalHeaderColor}</span>
                  <button
                    type="button"
                    onClick={() => setProposalHeaderColor('#1e293b')}
                    className="ml-auto text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                  >
                    Reset
                  </button>
                </div>
              </div>

              {/* Font family */}
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Font Style</label>
                <select
                  value={proposalFontFamily}
                  onChange={e => setProposalFontFamily(e.target.value as 'helvetica' | 'times' | 'courier')}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white focus:ring-2 focus:ring-violet-500 outline-none transition-all text-sm"
                >
                  <option value="helvetica">Helvetica (Modern)</option>
                  <option value="times">Times (Traditional)</option>
                  <option value="courier">Courier (Monospace)</option>
                </select>
              </div>

              {/* Cover notes */}
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                  Cover Page Notes
                  <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">optional</span>
                </label>
                <textarea
                  value={proposalCoverNotes}
                  onChange={e => setProposalCoverNotes(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-violet-500 outline-none transition-all resize-none text-sm"
                  placeholder="e.g. This proposal is valid for 30 days. Pricing excludes permits and inspections."
                />
              </div>

              {/* Valid until */}
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                  Valid Until
                  <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">optional</span>
                </label>
                <input
                  type="date"
                  value={proposalValidUntil}
                  onChange={e => setProposalValidUntil(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white focus:ring-2 focus:ring-violet-500 outline-none transition-all text-sm"
                />
              </div>

              {/* Terms & conditions */}
              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                  Terms &amp; Conditions
                  <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">optional — adds a page after the summary</span>
                </label>
                <textarea
                  value={proposalTerms}
                  onChange={e => setProposalTerms(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-violet-500 outline-none transition-all resize-none text-sm"
                  placeholder="e.g. Payment due within 30 days. All work is subject to standard industry practices..."
                />
              </div>

              <label className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={proposalIncludeSignature}
                  onChange={e => setProposalIncludeSignature(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-violet-600 focus:ring-violet-500"
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-800 dark:text-slate-200">Include signature block</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">Add acceptance signature lines to the cover page</span>
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={proposalIncludeTakeoffList}
                  onChange={e => setProposalIncludeTakeoffList(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-violet-600 focus:ring-violet-500"
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-800 dark:text-slate-200">Include takeoff list</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">Add a takeoff summary page with quantities and totals</span>
                </span>
              </label>

              <label className={`flex items-start gap-3 cursor-pointer group ${!proposalIncludeTakeoffList ? 'opacity-40 pointer-events-none' : ''}`}>
                <input
                  type="checkbox"
                  checked={proposalIncludeCostDetail}
                  onChange={e => setProposalIncludeCostDetail(e.target.checked)}
                  disabled={!proposalIncludeTakeoffList}
                  className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-violet-600 focus:ring-violet-500"
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-800 dark:text-slate-200">
                    Include cost detail
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Show unit rates and custom cost line items under each takeoff
                  </span>
                </span>
              </label>
              <div>
                <label className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={proposalIncludeHighlights}
                    onChange={e => setProposalIncludeHighlights(e.target.checked)}
                    className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-violet-600 focus:ring-violet-500"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-800 dark:text-slate-200">
                      Append highlighted plans
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Add annotated blueprint pages to the end of the PDF
                    </span>
                  </span>
                </label>
                {proposalIncludeHighlights && (
                  <div className="mt-3 ml-7">
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">
                      Blueprint Print Quality
                    </label>
                    <select
                      value={highlightQuality}
                      onChange={e => setHighlightQuality(e.target.value as HighlightQuality)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white text-sm focus:ring-2 focus:ring-violet-500 outline-none transition-all"
                    >
                      {(Object.entries(HIGHLIGHT_QUALITY_PRESETS) as [HighlightQuality, { label: string }][]).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              {project.address && (
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 rounded-lg px-3 py-2">
                  <MapPin size={13} />
                  <span>{project.address}</span>
                </div>
              )}
            </div>
            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-700 rounded-b-2xl flex justify-end gap-3 flex-shrink-0">
              <button
                onClick={() => setShowProposalModal(false)}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleGenerateProposal(proposalIncludeCostDetail, proposalIncludeHighlights, proposalHeaderColor, proposalCoverNotes, proposalFontFamily, proposalValidUntil, proposalTerms, proposalIncludeSignature, proposalIncludeTakeoffList)}
                className="px-5 py-2 bg-violet-600 text-white rounded-lg text-sm font-semibold hover:bg-violet-700 transition-colors shadow-sm flex items-center gap-2"
              >
                <FileText size={15} />
                Generate PDF
              </button>
            </div>
          </div>
        </div>
      )}

      <UploadFailuresModal
        open={showUploadFailuresModal}
        failures={uploadFailures}
        totalProcessed={uploadTotals.processed}
        totalExpected={uploadTotals.expected}
        isRetrying={isRetryingUpload}
        retryStatus={retryProgress.status}
        retryCurrent={retryProgress.current}
        retryTotal={retryProgress.total}
        retryFileName={retryProgress.fileName}
        canRetry={uploadFilesByName.size > 0}
        onRetry={handleRetryFailedPages}
        onClose={() => setShowUploadFailuresModal(false)}
      />
    </div>
  );
};
