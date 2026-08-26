// src/utils/sheetBridge.patch.test.ts
//
// Builds exceljs workbook fixtures in-memory, round-trips them through
// `workbookToFortuneSheets` (Task 1) to get realistic FortuneSheet state,
// mutates that state the way the FortuneSheet editor would, then patches the
// ORIGINAL workbook bytes via `patchWorkbookFromFortuneSheets` and reloads
// the output with a fresh exceljs Workbook to assert on the real xlsx bytes.

import { describe, it, expect } from 'vitest';
import type ExcelJS from 'exceljs';
import { workbookToFortuneSheets, patchWorkbookFromFortuneSheets, type BridgeResult } from './sheetBridge';
import type { Sheet as FortuneSheetData } from '@fortune-sheet/core';

async function loadExcelJS() {
  const { default: ExcelJSlib } = await import('exceljs');
  return ExcelJSlib;
}

async function buildFixtureWorkbook(): Promise<{ wb: ExcelJS.Workbook; buffer: ArrayBuffer }> {
  const ExcelJSlib = await loadExcelJS();
  const wb = new ExcelJSlib.Workbook();
  const ws = wb.addWorksheet('Data');

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

  const a2 = ws.getCell('A2');
  a2.value = 1234.5;
  a2.numFmt = '0.00';

  const a3 = ws.getCell('A3');
  a3.value = { formula: 'A2*2', result: 2469 };

  ws.mergeCells('B1:C2');
  ws.getCell('B1').value = 'merged';

  ws.getColumn(1).width = 20;
  ws.getRow(1).height = 30;

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  return { wb, buffer };
}

async function reload(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const ExcelJSlib = await loadExcelJS();
  const wb = new ExcelJSlib.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return wb;
}

describe('patchWorkbookFromFortuneSheets', () => {
  it('case 1: changing one cell value preserves every other cell style/value byte-meaningfully', async () => {
    const { buffer } = await buildFixtureWorkbook();
    const { sheets } = await workbookToFortuneSheets(buffer);

    const sheet = sheets[0];
    const a2 = sheet.celldata!.find((cd) => cd.r === 1 && cd.c === 0)!;
    a2.v!.v = 9999;
    a2.v!.m = '9999';

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, sheets);
    const outWb = await reload(outBytes);
    const outWs = outWb.worksheets[0];

    // Changed cell reflects the new value.
    expect(outWs.getCell('A2').value).toBe(9999);

    // A1's full style survives untouched.
    const a1 = outWs.getCell('A1');
    expect(a1.value).toBe('Hello');
    expect(a1.font?.bold).toBe(true);
    expect(a1.font?.italic).toBe(true);
    expect(a1.font?.size).toBe(14);
    expect(a1.font?.name).toBe('Arial');
    expect(a1.font?.color?.argb).toBe('FFFF0000');
    expect(a1.fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' } });
    expect(a1.alignment).toMatchObject({ horizontal: 'center', vertical: 'middle', wrapText: true });
    expect(a1.border?.top).toMatchObject({ style: 'thin', color: { argb: 'FF000000' } });
    expect(a1.border?.left).toMatchObject({ style: 'medium', color: { argb: 'FF111111' } });
    expect(a1.border?.bottom).toMatchObject({ style: 'thick', color: { argb: 'FF222222' } });
    expect(a1.border?.right).toMatchObject({ style: 'dashed', color: { argb: 'FF333333' } });

    // A3's formula + cached result survives.
    expect(outWs.getCell('A3').formula).toBe('A2*2');
    expect(outWs.getCell('A3').result).toBe(2469);
  });

  it('case 2: untouched round-trip preserves styles/merges/widths/frozen', async () => {
    const { buffer } = await buildFixtureWorkbook();
    const { sheets } = await workbookToFortuneSheets(buffer);

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, sheets);
    const outWb = await reload(outBytes);
    const outWs = outWb.worksheets[0];

    const a1 = outWs.getCell('A1');
    expect(a1.value).toBe('Hello');
    expect(a1.font?.bold).toBe(true);
    expect(a1.fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' } });

    expect(outWs.model.merges).toContain('B1:C2');
    expect(outWs.getCell('B1').value).toBe('merged');

    expect(outWs.getColumn(1).width).toBeCloseTo(20, 0);
    expect(outWs.getRow(1).height).toBeCloseTo(30, 0);

    const view = outWs.views?.[0];
    expect(view).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 1 });
  });

  it('case 3: image + data validation survive an unrelated cell edit', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.getCell('A1').value = 'Hello';
    ws.getCell('A2').value = 1;

    ws.getCell('A9').dataValidation = {
      type: 'list',
      formulae: ['"X,Y,Z"'],
      allowBlank: true,
    } as ExcelJS.DataValidation;

    const onePxPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const imageId = wb.addImage({ base64: `data:image/png;base64,${onePxPngBase64}`, extension: 'png' });
    ws.addImage(imageId, 'E5:F6');

    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
    const { sheets } = await workbookToFortuneSheets(buffer);

    const a1cd = sheets[0].celldata!.find((cd) => cd.r === 0 && cd.c === 0)!;
    a1cd.v!.v = 'Changed';
    a1cd.v!.m = 'Changed';

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, sheets);
    const outWb = await reload(outBytes);
    const outWs = outWb.worksheets[0];

    expect(outWs.getCell('A1').value).toBe('Changed');
    expect(outWs.getImages().length).toBeGreaterThan(0);
    const dv = (outWs.model as unknown as { dataValidations?: Record<string, unknown> }).dataValidations;
    expect(dv && Object.keys(dv).length).toBeGreaterThan(0);
  });

  it('structural: new sheet added, existing sheet deleted, output workbook has matching sheets', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    wb.addWorksheet('KeepMe').getCell('A1').value = 'kept';
    wb.addWorksheet('DeleteMe').getCell('A1').value = 'gone';
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const { sheets } = await workbookToFortuneSheets(buffer);
    // Remove "DeleteMe", add a brand-new sheet.
    const kept = sheets.filter((s) => s.name === 'KeepMe');
    const newSheet: FortuneSheetData = {
      name: 'BrandNew',
      id: 'sheet_new_uuid',
      order: 1,
      status: 0,
      celldata: [{ r: 0, c: 0, v: { v: 'fresh', m: 'fresh' } }],
    };
    const nextState = [...kept, newSheet];

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, nextState);
    const outWb = await reload(outBytes);

    const names = outWb.worksheets.map((w) => w.name);
    expect(names).toContain('KeepMe');
    expect(names).toContain('BrandNew');
    expect(names).not.toContain('DeleteMe');
    expect(outWb.getWorksheet('BrandNew')!.getCell('A1').value).toBe('fresh');
  });

  it('structural: renaming a sheet (id unchanged) preserves its content — matched by id, not name', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    const ws = wb.addWorksheet('Original');
    ws.getCell('A1').value = 'stays';
    ws.getCell('A1').font = { bold: true };
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const { sheets } = await workbookToFortuneSheets(buffer);
    // FortuneSheet's own setSheetName only mutates `.name`, never `.id` —
    // simulate a UI rename the same way.
    const renamed = sheets.map((s) => ({ ...s, name: 'Renamed' }));

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, renamed);
    const outWb = await reload(outBytes);

    const names = outWb.worksheets.map((w) => w.name);
    expect(names).toEqual(['Renamed']);
    const cell = outWb.getWorksheet('Renamed')!.getCell('A1');
    expect(cell.value).toBe('stays');
    expect(cell.font?.bold).toBe(true);
  });

  it('case 5: removed merge in state is unmerged in output; new merge is merged', async () => {
    const { buffer } = await buildFixtureWorkbook();
    const { sheets } = await workbookToFortuneSheets(buffer);

    const sheet = sheets[0];
    // Remove the existing B1:C2 merge.
    delete sheet.config!.merge!['0_1'];
    const b1cd = sheet.celldata!.find((cd) => cd.r === 0 && cd.c === 1)!;
    delete b1cd.v!.mc;
    // Add a new merge D1:E1.
    sheet.config!.merge!['0_3'] = { r: 0, c: 3, rs: 1, cs: 2 };
    sheet.celldata!.push({ r: 0, c: 3, v: { v: 'new-merge', m: 'new-merge', mc: { r: 0, c: 3, rs: 1, cs: 2 } } });

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, sheets);
    const outWb = await reload(outBytes);
    const outWs = outWb.worksheets[0];

    expect(outWs.model.merges).not.toContain('B1:C2');
    expect(outWs.model.merges).toContain('D1:E1');
  });

  it('case 6: a cell deleted in state is absent/empty in output', async () => {
    const { buffer } = await buildFixtureWorkbook();
    const { sheets } = await workbookToFortuneSheets(buffer);

    const sheet = sheets[0];
    sheet.celldata = sheet.celldata!.filter((cd) => !(cd.r === 1 && cd.c === 0)); // drop A2

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, sheets);
    const outWb = await reload(outBytes);
    const outWs = outWb.worksheets[0];

    expect(outWs.getCell('A2').value).toBeNull();
    // A1 (untouched) still present.
    expect(outWs.getCell('A1').value).toBe('Hello');
  });

  it('case 7: formula cells write `f` as formula (leading = stripped) and cached result when present', async () => {
    const { buffer } = await buildFixtureWorkbook();
    const { sheets } = await workbookToFortuneSheets(buffer);

    const sheet = sheets[0];
    // Change the formula and its cached result.
    const a3 = sheet.celldata!.find((cd) => cd.r === 2 && cd.c === 0)!;
    a3.v!.f = '=A2*10';
    a3.v!.v = 99990;
    a3.v!.m = '99990';

    // Add a formula cell with no cached result.
    sheet.celldata!.push({ r: 10, c: 0, v: { f: '=SUM(A2:A2)' } });

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, sheets);
    const outWb = await reload(outBytes);
    const outWs = outWb.worksheets[0];

    expect(outWs.getCell('A3').formula).toBe('A2*10');
    expect(outWs.getCell('A3').result).toBe(99990);

    expect(outWs.getCell('A11').formula).toBe('SUM(A2:A2)');
  });
});
