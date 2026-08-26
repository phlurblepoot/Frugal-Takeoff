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

// Inverse lookups, built once, for the patch/export direction.
const BORDER_STYLE_NAME: Record<number, ExcelJS.BorderStyle> = Object.fromEntries(
  Object.entries(BORDER_STYLE_CODE).map(([name, code]) => [code, name as ExcelJS.BorderStyle]),
);
const HORIZONTAL_ALIGN_NAME: Record<number, NonNullable<ExcelJS.Alignment['horizontal']>> = {
  0: 'center',
  1: 'left',
  2: 'right',
};
const VERTICAL_ALIGN_NAME: Record<number, NonNullable<ExcelJS.Alignment['vertical']>> = {
  0: 'middle',
  1: 'top',
  2: 'bottom',
};

// exceljs column widths are in "characters" (roughly the width of '0' in the
// default font); there is no exact universal char->px factor, but 7.5px per
// character-unit is the commonly used approximation for Excel's default
// Calibri 11 metric (same constant several open-source xlsx viewers use).
// This is an APPROXIMATION, not a verified exceljs constant.
const excelWidthToPx = (widthChars: number): number => Math.round(widthChars * 7.5);
const pxToExcelWidth = (px: number): number => px / 7.5;

// Row heights are stored in points; 1pt = 4/3 px at 96dpi (96/72 = 4/3).
const excelPointsToPx = (points: number): number => Math.round((points * 4) / 3);
const pxToExcelPoints = (px: number): number => (px * 3) / 4;

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

// Inverse of argbToHex: FortuneSheet '#rrggbb' -> exceljs 8-char AARRGGBB
// (opaque alpha, matching what every import-side fixture and this codebase's
// own writes use — exceljs has no concept of a "no alpha" color).
function hexToArgb(hex?: string): string | undefined {
  if (!hex) return undefined;
  const bare = hex.startsWith('#') ? hex.slice(1) : hex;
  return `FF${bare.toUpperCase()}`;
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

// ── Patch export (FortuneSheet -> original workbook) ────────────────────────
//
// Sheet-identity decision (brief's decide-and-document point): sheets are
// matched between the ORIGINAL workbook and the incoming FortuneSheet state
// by `id`, not by `name`. Verified in
// node_modules/@fortune-sheet/core/dist/index.js:
//   - `setSheetName()` (~line 76642) mutates ONLY `sheet.name` — `id` is
//     untouched — so a sheet renamed in the FortuneSheet editor keeps the
//     same `id` it had at import time.
//   - `addSheet()` (~line 67150) assigns a brand-new sheet either
//     `settings.generateSheetId()` or `uuid.v4()` — never anything shaped
//     like this bridge's own `sheet_${i}_${name}` import-time id scheme.
// Since `workbookToFortuneSheets` above mints ids as `sheet_${i}_${name}`
// (i = the ORIGINAL worksheet's index), this function recomputes that same
// scheme from the original workbook it's patching and matches incoming
// sheets against it by id. A sheet whose id doesn't match any recomputed
// original id is a NEW sheet (added in FortuneSheet); an original id with no
// matching incoming sheet was deleted. This means a rename is recognized as
// the SAME sheet (matched by id) rather than being treated as delete+add, so
// sheet-level artifacts (images, data validation, charts) on a renamed sheet
// survive — a strictly better outcome than name-matching, which is why id is
// used as the primary key here.
//
// Grid-clear strategy: rather than `worksheet.spliceRows` (which mutates row
// indices/structure, a much bigger hammer), every EXISTING cell is iterated
// and reset (value + style) before anything from the new state is written.
// Iterating the sheet's full existing extent this way also naturally clears
// any rows/columns that lie beyond the new state's occupied range (e.g. the
// grid shrank) without special-casing that as a separate pass.

function invertMergeRange(m: { r: number; c: number; rs: number; cs: number }): [number, number, number, number] {
  // 0-based {r,c,rs,cs} -> 1-based [top,left,bottom,right] for exceljs.
  return [m.r + 1, m.c + 1, m.r + m.rs, m.c + m.cs];
}

interface BorderInfoEntry {
  rangeType: string;
  value: {
    row_index: number;
    col_index: number;
    l: BorderSide | null;
    r: BorderSide | null;
    t: BorderSide | null;
    b: BorderSide | null;
  };
}

function borderSideToExcel(side: BorderSide | null | undefined): Partial<ExcelJS.Border> | undefined {
  if (!side) return undefined;
  const style = BORDER_STYLE_NAME[side.style];
  if (!style) return undefined;
  return { style, color: { argb: hexToArgb(side.color) ?? 'FF000000' } };
}

function applyBorderInfoEntry(worksheet: ExcelJS.Worksheet, entry: BorderInfoEntry): void {
  // This bridge only ever produces (and therefore only needs to consume)
  // the "cell" rangeType — see the import-side borderInfo.push() call above.
  if (entry.rangeType !== 'cell') return;
  const { row_index: rowIdx, col_index: colIdx, l, r, t, b } = entry.value;
  const top = borderSideToExcel(t);
  const left = borderSideToExcel(l);
  const bottom = borderSideToExcel(b);
  const right = borderSideToExcel(r);
  if (!top && !left && !bottom && !right) return;
  const cell = worksheet.getCell(rowIdx + 1, colIdx + 1);
  cell.border = {
    ...(top ? { top } : {}),
    ...(left ? { left } : {}),
    ...(bottom ? { bottom } : {}),
    ...(right ? { right } : {}),
  };
}

function applyCellValue(cell: ExcelJS.Cell, c: FortuneSheetCell): void {
  const numFmt = c.ct?.t === 'n' && c.ct.fa ? c.ct.fa : undefined;
  if (c.f) {
    // Leading '=' stripped for exceljs's {formula} shape (mirror image of
    // the import side's `out.f = '=' + cell.formula`).
    const formula = c.f.replace(/^=/, '');
    cell.value = (c.v !== undefined ? { formula, result: c.v } : { formula }) as ExcelJS.CellValue;
  } else if (c.v !== undefined) {
    cell.value = c.v;
  }
  if (numFmt) cell.numFmt = numFmt;
}

function applyCellFont(cell: ExcelJS.Cell, c: FortuneSheetCell): void {
  if (c.bl == null && c.it == null && c.fs == null && c.ff == null && c.fc == null) return;
  const font: Partial<ExcelJS.Font> = {};
  if (c.bl === 1) font.bold = true;
  if (c.it === 1) font.italic = true;
  if (c.fs != null) font.size = c.fs;
  if (c.ff != null) font.name = String(c.ff);
  const argb = hexToArgb(c.fc);
  if (argb) font.color = { argb };
  cell.font = font;
}

function applyCellFill(cell: ExcelJS.Cell, c: FortuneSheetCell): void {
  const argb = hexToArgb(c.bg);
  if (!argb) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function applyCellAlignment(cell: ExcelJS.Cell, c: FortuneSheetCell): void {
  const alignment: Partial<ExcelJS.Alignment> = {};
  let any = false;
  if (c.ht != null && HORIZONTAL_ALIGN_NAME[c.ht]) {
    alignment.horizontal = HORIZONTAL_ALIGN_NAME[c.ht];
    any = true;
  }
  if (c.vt != null && VERTICAL_ALIGN_NAME[c.vt]) {
    alignment.vertical = VERTICAL_ALIGN_NAME[c.vt];
    any = true;
  }
  if (c.tb === '2') {
    alignment.wrapText = true;
    any = true;
  }
  if (any) cell.alignment = alignment;
}

function rebuildWorksheetGrid(worksheet: ExcelJS.Worksheet, incoming: FortuneSheetData): void {
  // 1. Unmerge every existing merge FIRST — a merged non-anchor cell can't
  //    have its value/style touched directly (exceljs throws / no-ops), so
  //    this must happen before any clearing or rewriting below.
  for (const range of [...(worksheet.model.merges ?? [])]) {
    worksheet.unMergeCells(range);
  }

  // 2. Clear every existing cell (value + style) and explicit row height /
  //    column width — see the grid-clear strategy note above.
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.value = null;
      cell.style = {};
    });
    row.height = undefined;
  });
  worksheet.columns?.forEach((col) => {
    if (col) col.width = undefined;
  });

  // 3. Rebuild cell content + per-cell style from FortuneSheet celldata.
  for (const cd of incoming.celldata ?? []) {
    if (!cd.v) continue;
    const cell = worksheet.getCell(cd.r + 1, cd.c + 1);
    applyCellValue(cell, cd.v);
    applyCellFont(cell, cd.v);
    applyCellFill(cell, cd.v);
    applyCellAlignment(cell, cd.v);
  }

  // 4. Borders live in config.borderInfo, not on the cell entries themselves
  //    (mirrors the import-side split).
  for (const entry of (incoming.config?.borderInfo ?? []) as BorderInfoEntry[]) {
    applyBorderInfoEntry(worksheet, entry);
  }

  // 5. Merges: config.merge is the canonical source (matches the import
  //    side, which builds `merge` from `mergeByAnchor` and only ever mirrors
  //    it onto the anchor cell's `mc` as a convenience).
  for (const m of Object.values(incoming.config?.merge ?? {})) {
    worksheet.mergeCells(...invertMergeRange(m));
  }

  // 6. Column widths / row heights (inverse of the 7.5 / 4/3 factors).
  for (const [colKey, px] of Object.entries(incoming.config?.columnlen ?? {})) {
    worksheet.getColumn(Number(colKey) + 1).width = pxToExcelWidth(px);
  }
  for (const [rowKey, px] of Object.entries(incoming.config?.rowlen ?? {})) {
    worksheet.getRow(Number(rowKey) + 1).height = pxToExcelPoints(px);
  }

  // 7. Frozen panes (inverse of the row_focus/column_focus mapping above).
  //    'rangeRow'/'rangeColumn'/'rangeBoth' are out of scope: the import
  //    side never produces them either (see the frozen-mapping block above).
  if (incoming.frozen?.type && (incoming.frozen.type === 'row' || incoming.frozen.type === 'column' || incoming.frozen.type === 'both')) {
    const rowFocus = incoming.frozen.range?.row_focus ?? -1;
    const columnFocus = incoming.frozen.range?.column_focus ?? -1;
    const type = incoming.frozen.type;
    worksheet.views = [
      {
        state: 'frozen',
        xSplit: type === 'column' || type === 'both' ? columnFocus + 1 : 0,
        ySplit: type === 'row' || type === 'both' ? rowFocus + 1 : 0,
      },
    ];
  } else {
    worksheet.views = [];
  }
}

// Patches the ORIGINAL workbook bytes with the FortuneSheet state and returns
// new xlsx bytes. Per sheet (matched by id — see decision note above): the
// cell grid (values, formulas, styles, merges, widths/heights, frozen) is
// REBUILT from the FortuneSheet state — including structural changes
// (rows/cols/sheets added or removed), because the state already reflects
// them. Workbook- and sheet-level artifacts the grid doesn't own (charts,
// images, pivots, defined names, validation) survive because we never
// recreate the workbook, only mutate the loaded one in place.
// LIMITATION (documented): cell-anchored artifacts (images, validation
// ranges) do not shift when rows/cols are inserted/removed/moved — this
// bridge has no way to know which artifacts should move, since exceljs
// exposes no read model for e.g. charts and this bridge does not attempt
// structural diffing of row/col insertions.
export async function patchWorkbookFromFortuneSheets(
  originalXlsxBytes: ArrayBuffer | Buffer,
  sheets: FortuneSheetData[],
): Promise<Uint8Array> {
  const { default: ExcelJSlib } = await import('exceljs');
  const wb = new ExcelJSlib.Workbook();
  await wb.xlsx.load(originalXlsxBytes);

  // Recompute the same id scheme workbookToFortuneSheets used at import time.
  const originalWorksheets = wb.worksheets;
  const idToOriginal = new Map<string, ExcelJS.Worksheet>();
  originalWorksheets.forEach((ws, i) => idToOriginal.set(`sheet_${i}_${ws.name}`, ws));
  const matchedIds = new Set<string>();

  // New sheets are appended in the incoming state's relative order; existing
  // (matched) sheets keep their original position in the workbook — this
  // bridge does not attempt to re-order pre-existing sheets (out of scope:
  // not part of the behavior contract, and exceljs has no first-class
  // "move worksheet" API to do it safely).
  const orderedIncoming = [...sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  for (const incoming of orderedIncoming) {
    const original = incoming.id ? idToOriginal.get(incoming.id) : undefined;
    const worksheet = original ?? wb.addWorksheet(incoming.name);
    if (original && incoming.id) matchedIds.add(incoming.id);
    if (worksheet.name !== incoming.name) worksheet.name = incoming.name;

    rebuildWorksheetGrid(worksheet, incoming);
  }

  // Remove original sheets with no matching id in the incoming state.
  for (const [id, ws] of idToOriginal) {
    if (!matchedIds.has(id)) wb.removeWorksheet(ws.name);
  }

  const out = await wb.xlsx.writeBuffer();
  return new Uint8Array(out as ArrayBuffer);
}
