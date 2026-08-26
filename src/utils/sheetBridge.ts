// src/utils/sheetBridge.ts
//
// exceljs <-> FortuneSheet fidelity bridge. This file is ISOMORPHIC (no DOM,
// no Node-only APIs) — it runs both in the browser spreadsheet editor
// (display) and in the server-side flush/export engine, so nothing here may
// assume a `window`, `document`, or Node global (`Buffer`, `fs`, ...) exists.
//
// exceljs is loaded via dynamic `import()` (matching the precedent in
// src/pages/project/billing/aiaExcel.ts) so it stays out of eagerly-loaded
// bundles and only downloads when actually used, in both the browser and
// server builds.
//
// ---------------------------------------------------------------------------
// Verified API findings (see task-1-report.md for the full writeup):
//
// 1. Merge read-back: exceljs exposes merges through the PUBLIC
//    `worksheet.model.merges` getter (node_modules/exceljs/lib/doc/worksheet.js
//    ~line 878-880, typed in node_modules/exceljs/index.d.ts:995 as
//    `Range['range'][]`) rather than the private `worksheet._merges` map. It
//    yields plain "A1:B2"-style range strings (see the `range` getter in
//    node_modules/exceljs/lib/doc/range.js:200-202); there is no sheet-name
//    prefix for a same-sheet merge (Range#_serialisedSheetName is empty
//    whenever no `sheetName` was set — range.js:152-159). We parse these
//    strings ourselves (`parseMergeRange` below) since exceljs does not
//    publicly export its column/address codec.
//
// 2. FortuneSheet ht/vt convention: verified against
//    node_modules/@fortune-sheet/core/dist/index.js:53710-53739 (the
//    plain-text-wrap layout branch) — `ht === "0"` centers text
//    (textLeftAll = cellWidth / 2), `ht === "1"` left-aligns (textLeftAll = 0),
//    `ht === "2"` right-aligns. Same file confirms `vt === "0"` = middle,
//    `"1"` = top, `"2"` = bottom. So: ht 0=center/1=left/2=right,
//    vt 0=middle/1=top/2=bottom.
// ---------------------------------------------------------------------------

import type ExcelJS from 'exceljs';
import type { Sheet as FortuneSheetData, Cell as FortuneSheetCell } from '@fortune-sheet/core';

export interface BridgeResult {
  sheets: FortuneSheetData[];
  warnings: string[];
}

// ── Conversion constants ────────────────────────────────────────────────────

// FortuneSheet's border line-style numeric codes, taken verbatim from
// `getHtmlBorderStyle()` in
// node_modules/@fortune-sheet/core/dist/index.js:62581-62598. exceljs's own
// `BorderStyle` string union (index.d.ts:232-234) uses the exact same names
// (thin/dotted/hair/medium/double/thick/dashed/dashDot/dashDotDot/
// slantDashDot/mediumDashed/mediumDashDotDot/mediumDashDot), so the mapping
// below is a direct name lookup, not a guess.
const BORDER_STYLE_CODE: Record<string, number> = {
  thin: 1,
  hair: 2,
  dotted: 3,
  dashed: 4,
  dashDot: 5,
  dashDotDot: 6,
  double: 7,
  medium: 8,
  mediumDashed: 9,
  mediumDashDot: 10,
  mediumDashDotDot: 11,
  slantDashDot: 12,
  thick: 13,
};

// Verified against node_modules/@fortune-sheet/core/dist/index.js:53710-53739
// (see file header comment above).
const HORIZONTAL_ALIGN_CODE: Record<string, number> = { center: 0, left: 1, right: 2 };
const VERTICAL_ALIGN_CODE: Record<string, number> = { middle: 0, top: 1, bottom: 2 };

// exceljs column widths are in "characters" (roughly the width of '0' in the
// default font); there is no exact universal char->px factor, but 7.5px per
// character-unit is the commonly used approximation for Excel's default
// Calibri 11 metric (same constant several open-source xlsx viewers use).
// This is an APPROXIMATION, not a verified exceljs constant.
const excelWidthToPx = (widthChars: number): number => Math.round(widthChars * 7.5);

// Row heights are stored in points; 1pt = 4/3 px at 96dpi (96/72 = 4/3).
const excelPointsToPx = (points: number): number => Math.round((points * 4) / 3);

// Mirrors exceljs's own (private, non-exported) date<->serial conversion in
// node_modules/exceljs/lib/utils/utils.js:55-56
// (`dateToExcel(d) { return 25569 + d.getTime() / 86400000; }`), so serials
// produced here round-trip exactly the way exceljs's own writer would encode
// them. 25569 is the day-count from the 1900 date system epoch (1899-12-30,
// with the historical Feb-29-1900 bug baked in) to the Unix epoch.
const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const dateToExcelSerial = (d: Date): number => EXCEL_EPOCH_OFFSET_DAYS + d.getTime() / 86400000;

// ── Address / range parsing ─────────────────────────────────────────────────
// exceljs does not publicly export its column-letter codec, so we implement a
// small local one. Cell coordinates here are 0-based to match FortuneSheet's
// celldata r/c convention (see src/pages/SpreadsheetEditor.tsx's existing
// xlsxToFortuneSheets, which uses the same 0-based convention via
// XLSX.utils.decode_cell).

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseAddress(addr: string): { row: number; col: number } {
  const bare = addr.includes('!') ? addr.slice(addr.indexOf('!') + 1) : addr;
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(bare);
  if (!m) throw new Error(`sheetBridge: unparseable cell address "${addr}"`);
  return { row: parseInt(m[2], 10) - 1, col: colLetterToIndex(m[1].toUpperCase()) };
}

function parseMergeRange(range: string): { r: number; c: number; rs: number; cs: number } {
  const [tl, br] = range.split(':');
  const a = parseAddress(tl);
  const b = parseAddress(br ?? tl);
  return { r: a.row, c: a.col, rs: b.row - a.row + 1, cs: b.col - a.col + 1 };
}

function argbToHex(argb?: string): string | undefined {
  if (!argb) return undefined;
  // exceljs argb is 8 hex chars, AARRGGBB; FortuneSheet wants '#rrggbb'.
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  return `#${hex.toLowerCase()}`;
}

// ── Value normalization ─────────────────────────────────────────────────────

interface NormalizedValue {
  v: string | number | boolean;
  m: string;
  numeric: boolean;
}

// Reads what exceljs actually yields for cell.value / cell.result and
// normalizes it: strings and booleans pass through as-is; numbers pass
// through; dates convert to an Excel serial number (so ct:{t:'n'} + a date
// numFmt renders correctly) while keeping the ISO string as the human-
// readable `m` fallback (documented approximation — the true Excel display
// string would apply the numFmt's date pattern, which this bridge does not
// reimplement). Rich text / hyperlink / error objects are flattened to their
// plain-text representation on a best-effort basis.
function normalizeValue(raw: ExcelJS.CellValue): NormalizedValue | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    return { v: dateToExcelSerial(raw), m: raw.toISOString(), numeric: true };
  }
  if (typeof raw === 'number') return { v: raw, m: String(raw), numeric: true };
  if (typeof raw === 'boolean') return { v: raw, m: raw ? 'TRUE' : 'FALSE', numeric: false };
  if (typeof raw === 'string') return { v: raw, m: raw, numeric: false };
  if (typeof raw === 'object') {
    if ('richText' in raw && Array.isArray((raw as { richText: { text: string }[] }).richText)) {
      const text = (raw as { richText: { text: string }[] }).richText.map((rt) => rt.text).join('');
      return { v: text, m: text, numeric: false };
    }
    if ('text' in raw && 'hyperlink' in raw) {
      const text = String((raw as { text: unknown }).text ?? '');
      return { v: text, m: text, numeric: false };
    }
    if ('error' in raw) {
      const text = String((raw as { error: unknown }).error ?? '');
      return { v: text, m: text, numeric: false };
    }
  }
  return { v: String(raw), m: String(raw), numeric: false };
}

// ── Style mapping ────────────────────────────────────────────────────────────

function mapFont(font: Partial<ExcelJS.Font> | undefined, out: FortuneSheetCell): void {
  if (!font) return;
  if (font.bold) out.bl = 1;
  if (font.italic) out.it = 1;
  if (font.size != null) out.fs = font.size;
  if (font.name != null) out.ff = font.name;
  const fc = argbToHex(font.color?.argb);
  if (fc) out.fc = fc;
}

function mapFill(fill: ExcelJS.Fill | undefined, out: FortuneSheetCell): void {
  if (!fill || fill.type !== 'pattern' || fill.pattern !== 'solid') return;
  const bg = argbToHex(fill.fgColor?.argb);
  if (bg) out.bg = bg;
}

function mapAlignment(al: Partial<ExcelJS.Alignment> | undefined, out: FortuneSheetCell): void {
  if (!al) return;
  if (al.horizontal && al.horizontal in HORIZONTAL_ALIGN_CODE) {
    out.ht = HORIZONTAL_ALIGN_CODE[al.horizontal];
  }
  if (al.vertical && al.vertical in VERTICAL_ALIGN_CODE) {
    out.vt = VERTICAL_ALIGN_CODE[al.vertical];
  }
  if (al.wrapText) out.tb = '2';
}

interface BorderSide {
  style: number;
  color: string;
}

function mapBorderSide(b: Partial<ExcelJS.Border> | undefined): BorderSide | null {
  if (!b?.style) return null;
  const style = BORDER_STYLE_CODE[b.style];
  if (style == null) return null;
  return { style, color: argbToHex(b.color?.argb) ?? '#000000' };
}

// Cell.style getters on a never-touched cell return empty-but-defined
// sub-objects rather than throwing, so this is a plain truthiness scan — not
// a defensive null check.
function cellHasStyle(style: Partial<ExcelJS.Style>): boolean {
  const font = style.font;
  const fill = style.fill;
  const border = style.border;
  const alignment = style.alignment;
  return !!(
    font?.bold || font?.italic || font?.size != null || font?.name != null || font?.color?.argb ||
    (fill && fill.type === 'pattern' && fill.pattern === 'solid') ||
    border?.top?.style || border?.bottom?.style || border?.left?.style || border?.right?.style ||
    alignment?.horizontal || alignment?.vertical || alignment?.wrapText ||
    (style.numFmt && style.numFmt !== 'General')
  );
}

// ── Main bridge ──────────────────────────────────────────────────────────────

export async function workbookToFortuneSheets(xlsxBytes: ArrayBuffer | Buffer): Promise<BridgeResult> {
  const { default: ExcelJSlib } = await import('exceljs');
  const wb = new ExcelJSlib.Workbook();
  await wb.xlsx.load(xlsxBytes);

  const warnings: string[] = [];
  const sheets: FortuneSheetData[] = [];

  wb.worksheets.forEach((worksheet, i) => {
    const celldata: NonNullable<FortuneSheetData['celldata']> = [];
    const borderInfo: NonNullable<FortuneSheetData['config']>['borderInfo'] = [];
    let sawImage = false;
    // Data validation rules survive an xlsx round-trip at the *worksheet*
    // level (worksheet.model.dataValidations, an XML-wide map), not per
    // touched cell — a validation on an otherwise-blank cell leaves that
    // cell's row/col entirely absent from `row._cells` after reload (proven
    // empirically: eachRow/eachCell({includeEmpty:true}) never visits it), so
    // per-cell `cell.dataValidation` detection during the walk above is
    // unreliable and this is checked separately, once per sheet, instead.
    // exceljs's own model getter includes this field
    // (node_modules/exceljs/lib/doc/worksheet.js:846,
    // `dataValidations: this.dataValidations.model`) but its public
    // WorksheetModel type (index.d.ts:987) omits it — a real gap in
    // exceljs's own type declarations, not a guess on our part.
    const dataValidations = (worksheet.model as unknown as { dataValidations?: Record<string, unknown> })
      .dataValidations;
    const sawValidation = !!dataValidations && Object.keys(dataValidations).length > 0;

    // Anchor cells for merges, so we can attach `mc` while walking cells.
    const mergeByAnchor = new Map<string, { r: number; c: number; rs: number; cs: number }>();
    for (const range of worksheet.model.merges ?? []) {
      const parsed = parseMergeRange(range);
      mergeByAnchor.set(`${parsed.r}_${parsed.c}`, parsed);
    }

    worksheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        // Cells covered (but not anchored) by a merge carry no independent
        // content — exceljs's own `master` getter returns the cell itself
        // for an unmerged cell or the true master otherwise.
        if (cell.master !== cell) return;

        const hasValue = cell.value != null;
        const hasFormula = !!cell.formula;
        // exceljs's own `Address` interface (which `Cell` extends) types
        // `row`/`col` as `string`, but the runtime getters
        // (node_modules/exceljs/lib/doc/cell.js:127-133) return the actual
        // numeric row/column — another upstream type/impl mismatch. We
        // sidestep it entirely by parsing the (correctly string-typed)
        // `cell.address` through our own address parser instead.
        const { row: rowIdx, col: colIdx } = parseAddress(cell.address);
        const anchorKey = `${rowIdx}_${colIdx}`;
        const mc = mergeByAnchor.get(anchorKey);

        if (!hasValue && !hasFormula && !mc && !cellHasStyle(cell.style)) return;

        const out: FortuneSheetCell = {};

        if (hasFormula) {
          out.f = `=${cell.formula}`;
          const norm = normalizeValue(cell.result ?? null);
          if (norm) {
            out.v = norm.v;
            out.m = norm.m;
            if (norm.numeric && cell.numFmt && cell.numFmt !== 'General') {
              out.ct = { fa: cell.numFmt, t: 'n' };
            }
          }
        } else {
          const norm = normalizeValue(cell.value);
          if (norm) {
            out.v = norm.v;
            out.m = norm.m;
            if (norm.numeric && cell.numFmt && cell.numFmt !== 'General') {
              out.ct = { fa: cell.numFmt, t: 'n' };
            }
          }
        }

        mapFont(cell.style.font, out);
        mapFill(cell.style.fill, out);
        mapAlignment(cell.style.alignment, out);

        const l = mapBorderSide(cell.style.border?.left);
        const r = mapBorderSide(cell.style.border?.right);
        const t = mapBorderSide(cell.style.border?.top);
        const b = mapBorderSide(cell.style.border?.bottom);
        if (l || r || t || b) {
          borderInfo.push({
            rangeType: 'cell',
            value: { row_index: rowIdx, col_index: colIdx, l, r, t, b },
          });
        }

        if (mc) out.mc = mc;

        celldata.push({ r: rowIdx, c: colIdx, v: out });
      });
    });

    if (worksheet.getImages().length > 0) sawImage = true;
    if (sawImage) warnings.push(`Sheet "${worksheet.name}": images are preserved on save, not shown.`);
    if (sawValidation) {
      warnings.push(`Sheet "${worksheet.name}": data validation rules are preserved on save, not shown.`);
    }
    // exceljs's public API has no read model for charts or pivot tables at
    // all (no `chart`/`pivotTable` members on Worksheet in
    // node_modules/exceljs/index.d.ts), so this bridge cannot detect — and
    // therefore cannot warn about — either. They pass through the xlsx file
    // untouched on save regardless.

    const merge: NonNullable<FortuneSheetData['config']>['merge'] = {};
    for (const [key, m] of mergeByAnchor) merge[key] = m;

    const rowlen: Record<string, number> = {};
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      if (row.height != null) rowlen[String(row.number - 1)] = excelPointsToPx(row.height);
    });

    const columnlen: Record<string, number> = {};
    worksheet.columns?.forEach((col, idx) => {
      if (col?.width != null) columnlen[String(idx)] = excelWidthToPx(col.width);
    });

    const sheet: FortuneSheetData = {
      name: worksheet.name,
      id: `sheet_${i}_${worksheet.name}`,
      order: i,
      status: i === 0 ? 1 : 0,
      celldata,
      config: {
        ...(Object.keys(merge).length > 0 ? { merge } : {}),
        ...(Object.keys(rowlen).length > 0 ? { rowlen } : {}),
        ...(Object.keys(columnlen).length > 0 ? { columnlen } : {}),
        ...(borderInfo.length > 0 ? { borderInfo } : {}),
      },
    };

    const view = worksheet.views?.[0];
    if (view && view.state === 'frozen') {
      const xSplit = view.xSplit ?? 0;
      const ySplit = view.ySplit ?? 0;
      const type = xSplit > 0 && ySplit > 0 ? 'both' : ySplit > 0 ? 'row' : xSplit > 0 ? 'column' : undefined;
      if (type) {
        sheet.frozen = { type, range: { row_focus: ySplit - 1, column_focus: xSplit - 1 } };
      }
    }

    sheets.push(sheet);
  });

  return { sheets, warnings };
}
