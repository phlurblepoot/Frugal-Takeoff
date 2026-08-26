// src/utils/sheetBridge.import.test.ts
//
// Builds an exceljs workbook fully in-memory (no binary fixtures), writes it
// to a buffer, then round-trips it through `workbookToFortuneSheets` and
// asserts every mapping line in task-1-brief.md.

import { describe, it, expect, beforeAll } from 'vitest';
import type ExcelJS from 'exceljs';
import { workbookToFortuneSheets, type BridgeResult } from './sheetBridge';

let result: BridgeResult;

function cellAt(sheetIndex: number, r: number, c: number) {
  const sheet = result.sheets[sheetIndex];
  return sheet.celldata?.find((cd) => cd.r === r && cd.c === c)?.v;
}

beforeAll(async () => {
  const { default: ExcelJSlib } = await import('exceljs');
  const wb = new ExcelJSlib.Workbook();

  // ── Sheet 1: "Data" — covers every mapping line ───────────────────────────
  const ws = wb.addWorksheet('Data');

  // A1: styled string cell — font (bold/italic/size/name/color), solid fill,
  // alignment (center/middle/wrap), border on all four sides.
  const a1 = ws.getCell('A1');
  a1.value = 'Hello';
  a1.font = { bold: true, italic: true, size: 14, name: 'Arial', color: { argb: 'FFFF0000' } };
  a1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' } };
  a1.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  a1.border = {
    top: { style: 'thin', color: { argb: 'FF000000' } },
    left: { style: 'medium', color: { argb: 'FF111111' } },
    bottom: { style: 'thick', color: { argb: 'FF222222' } },
    right: { style: 'dashed', color: { argb: 'FF333333' } },
  };

  // A2: number with numFmt.
  const a2 = ws.getCell('A2');
  a2.value = 1234.5;
  a2.numFmt = '0.00';

  // A3: formula with cached result.
  const a3 = ws.getCell('A3');
  a3.value = { formula: 'A2*2', result: 2469 };

  // A4: boolean.
  ws.getCell('A4').value = true;

  // A5: date.
  const testDate = new Date(Date.UTC(2024, 5, 15, 0, 0, 0));
  ws.getCell('A5').value = testDate;

  // A6: alignment left/top (the other branch of the ht/vt mapping).
  const a6 = ws.getCell('A6');
  a6.value = 'left-top';
  a6.alignment = { horizontal: 'left', vertical: 'top' };

  // A7: alignment right/bottom.
  const a7 = ws.getCell('A7');
  a7.value = 'right-bottom';
  a7.alignment = { horizontal: 'right', vertical: 'bottom' };

  // Merge B1:C2.
  ws.mergeCells('B1:C2');
  ws.getCell('B1').value = 'merged';

  // Column width (A -> 20 chars) and row height (row 1 -> 30pt).
  ws.getColumn(1).width = 20;
  ws.getRow(1).height = 30;

  // Frozen panes: freeze first row + first column ("both").
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  // Data validation (unsupported content -> warning).
  ws.getCell('A9').dataValidation = {
    type: 'list',
    formulae: ['"X,Y,Z"'],
    allowBlank: true,
  } as ExcelJS.DataValidation;

  // Image (unsupported content -> warning). A minimal 1x1 red PNG, base64.
  const onePxPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const imageId = wb.addImage({ base64: `data:image/png;base64,${onePxPngBase64}`, extension: 'png' });
  ws.addImage(imageId, 'E5:F6');

  // ── Sheet 2: minimal second sheet (multi-sheet handling) ─────────────────
  const ws2 = wb.addWorksheet('Second');
  ws2.getCell('A1').value = 'sheet two';

  const buffer = await wb.xlsx.writeBuffer();
  result = await workbookToFortuneSheets(buffer as unknown as ArrayBuffer);
});

describe('workbookToFortuneSheets', () => {
  it('produces one FortuneSheet per exceljs worksheet, in order, with expected id/order/status', () => {
    expect(result.sheets).toHaveLength(2);
    expect(result.sheets[0].name).toBe('Data');
    expect(result.sheets[0].order).toBe(0);
    expect(result.sheets[0].status).toBe(1);
    expect(result.sheets[1].name).toBe('Second');
    expect(result.sheets[1].order).toBe(1);
    expect(result.sheets[1].status).toBe(0);
    expect(cellAt(1, 0, 0)?.v).toBe('sheet two');
  });

  it('maps a plain string value', () => {
    const cell = cellAt(0, 0, 0)!;
    expect(cell.v).toBe('Hello');
    expect(cell.m).toBe('Hello');
  });

  it('maps font: bold, italic, size, name, color', () => {
    const cell = cellAt(0, 0, 0)!;
    expect(cell.bl).toBe(1);
    expect(cell.it).toBe(1);
    expect(cell.fs).toBe(14);
    expect(cell.ff).toBe('Arial');
    expect(cell.fc).toBe('#ff0000');
  });

  it('maps solid fill to bg', () => {
    const cell = cellAt(0, 0, 0)!;
    expect(cell.bg).toBe('#00ff00');
  });

  it('maps alignment: horizontal center -> ht 0, vertical middle -> vt 0, wrapText -> tb "2"', () => {
    const cell = cellAt(0, 0, 0)!;
    expect(cell.ht).toBe(0);
    expect(cell.vt).toBe(0);
    expect(cell.tb).toBe('2');
  });

  it('maps alignment: horizontal left -> ht 1, vertical top -> vt 1', () => {
    const cell = cellAt(0, 5, 0)!; // A6
    expect(cell.ht).toBe(1);
    expect(cell.vt).toBe(1);
  });

  it('maps alignment: horizontal right -> ht 2, vertical bottom -> vt 2', () => {
    const cell = cellAt(0, 6, 0)!; // A7
    expect(cell.ht).toBe(2);
    expect(cell.vt).toBe(2);
  });

  it('maps borders on all four sides with FortuneSheet style codes + hex colors', () => {
    const sheet = result.sheets[0];
    const entry = sheet.config?.borderInfo?.find(
      (b: { value: { row_index: number; col_index: number } }) => b.value.row_index === 0 && b.value.col_index === 0,
    );
    expect(entry).toBeTruthy();
    expect(entry.rangeType).toBe('cell');
    expect(entry.value.t).toEqual({ style: 1, color: '#000000' }); // thin
    expect(entry.value.l).toEqual({ style: 8, color: '#111111' }); // medium
    expect(entry.value.b).toEqual({ style: 13, color: '#222222' }); // thick
    expect(entry.value.r).toEqual({ style: 4, color: '#333333' }); // dashed
  });

  it('maps a numFmt-carrying number to ct + keeps a raw display string in m', () => {
    const cell = cellAt(0, 1, 0)!; // A2
    expect(cell.v).toBe(1234.5);
    expect(cell.ct).toEqual({ fa: '0.00', t: 'n' });
    expect(cell.m).toBe('1234.5');
  });

  it('maps a formula to f + cached v from the result', () => {
    const cell = cellAt(0, 2, 0)!; // A3
    expect(cell.f).toBe('=A2*2');
    expect(cell.v).toBe(2469);
    expect(cell.m).toBe('2469');
  });

  it('maps a boolean value', () => {
    const cell = cellAt(0, 3, 0)!; // A4
    expect(cell.v).toBe(true);
    expect(cell.m).toBe('TRUE');
  });

  it('maps a date value to an Excel serial number with an ISO string in m', () => {
    const cell = cellAt(0, 4, 0)!; // A5
    // 2024-06-15 UTC -> serial 45458 (25569 + days since Unix epoch).
    expect(cell.v).toBeCloseTo(45458, 5);
    expect(cell.m).toBe('2024-06-15T00:00:00.000Z');
  });

  it('maps merges to config.merge entries and the anchor cell mc', () => {
    const sheet = result.sheets[0];
    expect(sheet.config?.merge?.['0_1']).toEqual({ r: 0, c: 1, rs: 2, cs: 2 });
    const anchor = cellAt(0, 0, 1)!; // B1
    expect(anchor.mc).toEqual({ r: 0, c: 1, rs: 2, cs: 2 });
  });

  it('maps column width (chars) to config.columnlen px via the 7.5 factor', () => {
    const sheet = result.sheets[0];
    expect(sheet.config?.columnlen?.['0']).toBe(Math.round(20 * 7.5)); // 150
  });

  it('maps row height (points) to config.rowlen px via the 4/3 factor', () => {
    const sheet = result.sheets[0];
    expect(sheet.config?.rowlen?.['0']).toBe(Math.round(30 * (4 / 3))); // 40
  });

  it('maps a frozen row+column pane to frozen.type "both" with 0-based focus', () => {
    const sheet = result.sheets[0];
    expect(sheet.frozen).toEqual({ type: 'both', range: { row_focus: 0, column_focus: 0 } });
  });

  it('emits a warning for unsupported data validation, not rendered as a cell', () => {
    expect(result.warnings.some((w) => /data validation/i.test(w))).toBe(true);
  });

  it('emits a warning for unsupported images, not rendered as a cell', () => {
    expect(result.warnings.some((w) => /image/i.test(w))).toBe(true);
  });
});
