// src/utils/sheetBridge.patch.test.ts
//
// Builds exceljs workbook fixtures in-memory, round-trips them through
// `workbookToFortuneSheets` (Task 1) to get realistic FortuneSheet state,
// mutates that state the way the FortuneSheet editor would, then patches the
// ORIGINAL workbook bytes via `patchWorkbookFromFortuneSheets` and reloads
// the output with a fresh exceljs Workbook to assert on the real xlsx bytes.

import { describe, it, expect } from 'vitest';
import type ExcelJS from 'exceljs';
import { workbookToFortuneSheets, patchWorkbookFromFortuneSheets, ensureSheetCelldata, type BridgeResult } from './sheetBridge';
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

  it('structural: an id-less incoming sheet falls back to matching an original by name, preserving its image', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.getCell('A1').value = 'Hello';

    const onePxPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const imageId = wb.addImage({ base64: `data:image/png;base64,${onePxPngBase64}`, extension: 'png' });
    ws.addImage(imageId, 'E5:F6');

    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
    const { sheets } = await workbookToFortuneSheets(buffer);

    // Strip the id entirely (simulates state that never carried one) and
    // change one unrelated cell.
    const sheet = sheets[0];
    delete sheet.id;
    const a1cd = sheet.celldata!.find((cd) => cd.r === 0 && cd.c === 0)!;
    a1cd.v!.v = 'Changed';
    a1cd.v!.m = 'Changed';

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, sheets);
    const outWb = await reload(outBytes);
    const outWs = outWb.worksheets[0];

    // Matched the original "Data" sheet by name (not id) — no duplicate sheet.
    expect(outWb.worksheets).toHaveLength(1);
    expect(outWs.name).toBe('Data');
    expect(outWs.getCell('A1').value).toBe('Changed');
    // The image survived because the id-less sheet was matched to the
    // original by name instead of being treated as a brand-new sheet.
    expect(outWs.getImages().length).toBeGreaterThan(0);
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

  // WS5 task 9 regression pin: FortuneSheet's own onChange payload for a
  // LIVE-EDITED sheet is `data`-shaped (a dense 2D matrix, nulls for empty
  // cells), NOT `celldata`-shaped (the sparse list every other test in this
  // file uses, matching workbookToFortuneSheets's import output). Before
  // this fix, rebuildWorksheetGrid only ever read `celldata`, so autosaving
  // a live edit silently blanked the sheet (found while writing the WS5 e2e
  // fidelity proof — see task-9-report.md). Pinned here so a regression
  // fails a fast unit test, not just the slower e2e proof.
  function buildDataShapedSheet(id: string, name: string): FortuneSheetData {
    return {
      name,
      id,
      order: 0,
      status: 1,
      config: {},
      data: [
        [{ v: 'Hello', m: 'Hello' }, { v: 42, m: '42' }],
        [null, null],
      ],
    } as FortuneSheetData;
  }

  it('patchWorkbookFromFortuneSheets writes values correctly from a data-shaped sheet carrying no celldata at all', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    wb.addWorksheet('Data').getCell('A1').value = 'Original';
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const sheet = buildDataShapedSheet('sheet_0_Data', 'Data');
    expect(sheet.celldata).toBeUndefined();

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, [sheet]);
    const outWb = await reload(outBytes);
    const outWs = outWb.worksheets[0];

    expect(outWs.getCell('A1').value).toBe('Hello');
    expect(outWs.getCell('B1').value).toBe(42);
  });

  // C1 regression: a second flush of the SAME client state must not throw.
  // patchWorkbookFromFortuneSheets recomputes sheet ids as `sheet_${i}_${name}`
  // from the bytes it's patching every time, but the client's incoming state
  // carries ids minted once at import — after the FIRST flush applies a
  // rename or a delete (which shifts later sheets' indices), those recomputed
  // ids no longer match. Before the fix, an id-carrying sheet that missed by
  // id never fell back to name-matching, so it hit `wb.addWorksheet` while
  // the same-named sheet still existed — exceljs's name setter throws
  // "Worksheet name already exists".
  it('C1: double-patching a rename does not throw (id no longer matches post-rename bytes)', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    const ws = wb.addWorksheet('Original');
    ws.getCell('A1').value = 'stays';
    ws.getCell('A1').font = { bold: true };
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const { sheets } = await workbookToFortuneSheets(buffer);
    // Simulates a UI rename: id unchanged (FortuneSheet's setSheetName only
    // mutates `.name`), same state object re-sent on every flush.
    const renamed = sheets.map((s) => ({ ...s, name: 'Renamed' }));

    const out1 = await patchWorkbookFromFortuneSheets(buffer, renamed);
    // Flush 2: the SAME incoming state (still carrying the pre-rename id),
    // now patched against bytes that already reflect the rename. Must not
    // throw.
    const out2 = await patchWorkbookFromFortuneSheets(out1, renamed);

    const outWb = await reload(out2);
    expect(outWb.worksheets.map((w) => w.name)).toEqual(['Renamed']);
    const cell = outWb.getWorksheet('Renamed')!.getCell('A1');
    expect(cell.value).toBe('stays');
    expect(cell.font?.bold).toBe(true);
  });

  it('C1: double-patching a delete of sheet 1 of 2 does not throw (index shift breaks the recomputed id)', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    wb.addWorksheet('A').getCell('A1').value = 'a';
    wb.addWorksheet('B').getCell('A1').value = 'b';
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const { sheets } = await workbookToFortuneSheets(buffer);
    // Delete sheet 1 of 2 ("A"), keep "B" — but "B"'s id was minted as
    // `sheet_1_B` (its ORIGINAL index). Once "A" is gone, "B" becomes index 0
    // in the output bytes, so a second flush recomputes `sheet_0_B` — a miss
    // against the incoming state's still-`sheet_1_B` id.
    const kept = sheets.filter((s) => s.name === 'B');

    const out1 = await patchWorkbookFromFortuneSheets(buffer, kept);
    const out2 = await patchWorkbookFromFortuneSheets(out1, kept); // must not throw

    const outWb = await reload(out2);
    expect(outWb.worksheets.map((w) => w.name)).toEqual(['B']);
    expect(outWb.getWorksheet('B')!.getCell('A1').value).toBe('b');
  });

  // N1 regression (micro-fix round — found by the re-review of the C1 fix):
  // the broadened id-miss->name-fallback had no `matchedOriginals` guard on
  // the ID-match branch — only the name-fallback branch checked it. So when
  // one incoming sheet resolves by id (a rename — id unchanged) and a
  // DIFFERENT incoming sheet resolves by name-fallback to that SAME
  // original (a genuinely new sheet reusing the name the rename just
  // freed, in the SAME flush), whichever was processed first (by `order`)
  // claimed the original, and the id-match branch — being unguarded — then
  // blindly reused that already-claimed worksheet anyway, silently
  // overwriting one sheet's data with the other's. No error, no warning.
  // Fixed by resolving every incoming sheet's original in two
  // order-independent passes (ids first, unconditionally ahead of any name
  // match) before any mutation happens — this test proves BOTH `order`
  // orderings produce the same (correct) two-sheet result.
  it('N1: a rename and a distinct new sheet reusing the freed name resolve correctly regardless of order', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    wb.addWorksheet('Sheet1').getCell('A1').value = 'original';
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const { sheets } = await workbookToFortuneSheets(buffer);
    const originalSheet = sheets[0]; // id 'sheet_0_Sheet1', name 'Sheet1'

    const buildState = (renamedOrder: number, newSheetOrder: number): FortuneSheetData[] => {
      const renamed: FortuneSheetData = { ...originalSheet, name: 'Renamed', order: renamedOrder };
      const newSheet: FortuneSheetData = {
        name: 'Sheet1', // reuses the name the rename just freed, in the SAME flush
        id: 'sheet_brand_new_uuid',
        order: newSheetOrder,
        status: 0,
        celldata: [{ r: 0, c: 0, v: { v: 'new-sheet-data', m: 'new-sheet-data' } }],
      };
      return [renamed, newSheet];
    };

    const assertBothSheetsSurvive = (outWb: ExcelJS.Workbook) => {
      expect(outWb.worksheets).toHaveLength(2);
      expect(outWb.getWorksheet('Renamed')!.getCell('A1').value).toBe('original');
      expect(outWb.getWorksheet('Sheet1')!.getCell('A1').value).toBe('new-sheet-data');
    };

    // Ordering A: the renamed (id-matching) sheet's `order` comes first.
    const outA = await patchWorkbookFromFortuneSheets(buffer, buildState(0, 1));
    assertBothSheetsSurvive(await reload(outA));

    // Ordering B: the new (name-fallback-matching) sheet's `order` comes
    // first — this is the ordering the re-review's repro used to reproduce
    // silent data loss before the fix.
    const outB = await patchWorkbookFromFortuneSheets(buffer, buildState(1, 0));
    assertBothSheetsSurvive(await reload(outB));
  });

  // N3 regression (micro-fix round #2 — found by the re-review of the N1
  // fix): removal of unmatched originals used to run AFTER pass 3's
  // renames, so a rename targeting a name still held by a
  // soon-to-be-deleted-but-not-yet original collided with it and exceljs
  // threw "Worksheet name already exists". Delete sheet B + rename A to the
  // name B just freed, in the same flush, double-patched (mirrors the C1
  // double-patch protocol — ids are minted once and never change).
  it('N3: delete sheet B + rename A to the freed name "B" does not throw, double-patched', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    wb.addWorksheet('A').getCell('A1').value = 'a-data';
    wb.addWorksheet('B').getCell('A1').value = 'b-data';
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const { sheets } = await workbookToFortuneSheets(buffer);
    const aSheet = sheets.find((s) => s.name === 'A')!;
    // Keep only A (renamed to "B") — B is deleted (absent from the state).
    const state: FortuneSheetData[] = [{ ...aSheet, name: 'B' }];

    const assertCorrect = (outWb: ExcelJS.Workbook) => {
      expect(outWb.worksheets.map((w) => w.name)).toEqual(['B']);
      expect(outWb.getWorksheet('B')!.getCell('A1').value).toBe('a-data');
    };

    const out1 = await patchWorkbookFromFortuneSheets(buffer, state);
    assertCorrect(await reload(out1));

    const out2 = await patchWorkbookFromFortuneSheets(out1, state); // must not throw
    assertCorrect(await reload(out2));
  });

  // N3 regression: a rename CHAIN among surviving matched originals (B's
  // name is freed by B->C at the same time A wants that exact name) is a
  // strictly harder case than a delete — both conflicting names belong to
  // sheets that survive this flush, so it can't be fixed by reordering
  // removal alone. Both `.order` orderings must resolve correctly.
  it('N3: a rename chain (A->B, B->C) resolves correctly regardless of order', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    wb.addWorksheet('A').getCell('A1').value = 'a-data';
    wb.addWorksheet('B').getCell('A1').value = 'b-data';
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const { sheets } = await workbookToFortuneSheets(buffer);
    const aSheet = sheets.find((s) => s.name === 'A')!;
    const bSheet = sheets.find((s) => s.name === 'B')!;

    const buildState = (aOrder: number, bOrder: number): FortuneSheetData[] => [
      { ...aSheet, name: 'B', order: aOrder },
      { ...bSheet, name: 'C', order: bOrder },
    ];

    const assertChainCorrect = (outWb: ExcelJS.Workbook) => {
      expect(outWb.worksheets.map((w) => w.name).sort()).toEqual(['B', 'C']);
      expect(outWb.getWorksheet('B')!.getCell('A1').value).toBe('a-data');
      expect(outWb.getWorksheet('C')!.getCell('A1').value).toBe('b-data');
    };

    const outA = await patchWorkbookFromFortuneSheets(buffer, buildState(0, 1));
    assertChainCorrect(await reload(outA));

    const outB = await patchWorkbookFromFortuneSheets(buffer, buildState(1, 0));
    assertChainCorrect(await reload(outB));
  });

  // N3 regression: a full name SWAP is the chain's limit case — both names
  // are simultaneously "wanted" and "held", so neither a straight rename
  // pass nor a simple reorder can resolve it without the temp-name
  // indirection.
  it('N3: a full name swap (A<->B) resolves correctly, not a collision', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    wb.addWorksheet('A').getCell('A1').value = 'a-data';
    wb.addWorksheet('B').getCell('A1').value = 'b-data';
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const { sheets } = await workbookToFortuneSheets(buffer);
    const aSheet = sheets.find((s) => s.name === 'A')!;
    const bSheet = sheets.find((s) => s.name === 'B')!;
    const swapped: FortuneSheetData[] = [
      { ...aSheet, name: 'B' },
      { ...bSheet, name: 'A' },
    ];

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, swapped);
    const outWb = await reload(outBytes);
    expect(outWb.worksheets.map((w) => w.name).sort()).toEqual(['A', 'B']);
    expect(outWb.getWorksheet('B')!.getCell('A1').value).toBe('a-data');
    expect(outWb.getWorksheet('A')!.getCell('A1').value).toBe('b-data');
  });

  // M2 regression: a matched EXISTING sheet's non-frozen view settings (zoom,
  // gridlines, rtl) must survive a rebuild untouched — previously every
  // rebuild unconditionally set `views = []` for a non-frozen sheet, wiping
  // them even though nothing about them changed.
  it('M2: a non-frozen sheet keeps its zoom/gridline/rtl view settings across a patch', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.getCell('A1').value = 'Hello';
    ws.views = [{ state: 'normal', zoomScale: 85, showGridLines: false, rightToLeft: true }];
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const { sheets } = await workbookToFortuneSheets(buffer);
    const a1cd = sheets[0].celldata!.find((cd) => cd.r === 0 && cd.c === 0)!;
    a1cd.v!.v = 'Changed';
    a1cd.v!.m = 'Changed';

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, sheets);
    const outWb = await reload(outBytes);
    const view = outWb.worksheets[0].views?.[0] as unknown as
      { zoomScale?: number; showGridLines?: boolean; rightToLeft?: boolean } | undefined;

    expect(view?.zoomScale).toBe(85);
    expect(view?.showGridLines).toBe(false);
    expect(view?.rightToLeft).toBe(true);
  });

  // M2 regression, other direction: un-freezing an existing sheet must
  // actually drop the frozen-pane state (not get stuck forever by blindly
  // restoring the sheet's prior view wholesale).
  it('M2: un-freezing an existing sheet drops the frozen pane state', async () => {
    const { buffer } = await buildFixtureWorkbook(); // frozen at xSplit:1/ySplit:1
    const { sheets } = await workbookToFortuneSheets(buffer);
    const sheet = sheets[0];
    expect(sheet.frozen).toBeDefined();
    delete sheet.frozen; // simulate the user un-freezing in the FortuneSheet UI

    const outBytes = await patchWorkbookFromFortuneSheets(buffer, sheets);
    const outWb = await reload(outBytes);
    const view = outWb.worksheets[0].views?.[0] as unknown as { state?: string } | undefined;
    expect(view?.state).toBe('normal');
  });

  // M1 regression: rich text and hyperlink cells are flattened on import
  // (normalizeValue), and the bridge must tell the user via its warnings —
  // the same mechanism already used for images/data-validation.
  it('M1: rich text and hyperlink cells produce import warnings', async () => {
    const ExcelJSlib = await loadExcelJS();
    const wb = new ExcelJSlib.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.getCell('A1').value = { richText: [{ text: 'Hello ' }, { text: 'World', font: { bold: true } }] };
    ws.getCell('A2').value = { text: 'Anthropic', hyperlink: 'https://anthropic.com' };
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;

    const { sheets, warnings } = await workbookToFortuneSheets(buffer);

    expect(warnings.some((w) => /rich text/i.test(w))).toBe(true);
    expect(warnings.some((w) => /hyperlink/i.test(w))).toBe(true);
    // Still flattened to plain text for display, as before.
    const a1 = sheets[0].celldata!.find((cd) => cd.r === 0 && cd.c === 0)!;
    expect(a1.v!.v).toBe('Hello World');
    const a2 = sheets[0].celldata!.find((cd) => cd.r === 1 && cd.c === 0)!;
    expect(a2.v!.v).toBe('Anthropic');
  });

  it('ensureSheetCelldata converts a data-shaped sheet to celldata with correct r/c/v entries, and leaves celldata-shaped input untouched', () => {
    const dataSheet = buildDataShapedSheet('sheet_0_Data', 'Data');
    const normalized = ensureSheetCelldata(dataSheet);

    expect(normalized.celldata).toEqual([
      { r: 0, c: 0, v: { v: 'Hello', m: 'Hello' } },
      { r: 0, c: 1, v: { v: 42, m: '42' } },
    ]);

    const celldataSheet: FortuneSheetData = {
      name: 'Data',
      id: 'sheet_0_Data',
      order: 0,
      status: 1,
      celldata: [{ r: 0, c: 0, v: { v: 'already', m: 'already' } }],
    };
    // Untouched means the SAME reference comes back — no unnecessary work,
    // and proof the celldata-shaped (normal import) case is a true no-op.
    expect(ensureSheetCelldata(celldataSheet)).toBe(celldataSheet);
  });
});
