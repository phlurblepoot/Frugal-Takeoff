// src/pages/project/billing/aiaExcel.test.ts
//
// exceljs is a node-oriented library; the workbook builder is pure (no DOM), so
// these tests assert STRUCTURE + the reconciling NUMBERS — not pixel layout.
import { describe, it, expect } from 'vitest';
import { buildAiaWorkbook, type AiaExportCtx } from './aiaExcel';
import type { AiaG702, AiaG703Row, AiaSovLine, AiaPayApp, AiaSettings } from '../../../utils/store';

// Two SOV lines + one change-order line. Cents chosen so totals reconcile.
const sovLines: AiaSovLine[] = [
  { id: 'sov1', projectId: 'p1', itemNo: '001', description: 'Mobilization', scheduledValueCents: 100000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 0, version: 1, createdAt: 0 },
  { id: 'sov2', projectId: 'p1', itemNo: '002', description: 'Framing', scheduledValueCents: 500000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 1, version: 1, createdAt: 0 },
  { id: 'sov3', projectId: 'p1', itemNo: 'CO-1', description: 'Extra door', scheduledValueCents: 50000, retainagePercent: null, isChangeOrder: 1, changeOrderId: 'co1', sortOrder: 2, version: 1, createdAt: 0 },
];

const g703: AiaG703Row[] = [
  { sovLineId: 'sov1', itemNo: '001', description: 'Mobilization', isChangeOrder: 0, scheduledValueCents: 100000, previousCents: 50000, thisPeriodCents: 50000, storedCents: 0, totalToDateCents: 100000, percentComplete: 100, balanceToFinishCents: 0, retainageCents: 10000 },
  { sovLineId: 'sov2', itemNo: '002', description: 'Framing', isChangeOrder: 0, scheduledValueCents: 500000, previousCents: 100000, thisPeriodCents: 150000, storedCents: 50000, totalToDateCents: 300000, percentComplete: 60, balanceToFinishCents: 200000, retainageCents: 30000 },
  { sovLineId: 'sov3', itemNo: 'CO-1', description: 'Extra door', isChangeOrder: 1, scheduledValueCents: 50000, previousCents: 0, thisPeriodCents: 25000, storedCents: 0, totalToDateCents: 25000, percentComplete: 50, balanceToFinishCents: 25000, retainageCents: 2500 },
];

// ΣC = 650000 (L3), ΣG = 425000 (L4), ΣRet = 42500 (L5).
const g702: AiaG702 = {
  L1originalContractCents: 600000,
  L2changeOrdersCents: 50000,
  L3contractSumToDateCents: 650000,
  L4totalCompletedStoredCents: 425000,
  L5aRetainageWorkCents: 37500,
  L5bRetainageStoredCents: 5000,
  L5retainageCents: 42500,
  L6earnedLessRetainageCents: 382500,
  L7lessPreviousCents: 135000,
  L8currentPaymentDueCents: 247500,
  L9balanceToFinishCents: 267500,
  changeOrders: { additionsCents: 50000, deductionsCents: 0, netCents: 50000 },
};

const app: AiaPayApp = {
  id: 'app1', projectId: 'p1', number: 3,
  periodTo: '2026-06-30', applicationDate: '2026-07-01',
  retainagePercent: 10, storedRetainagePercent: 10,
  status: 'draft', version: 1, createdAt: 0,
};

const aiaSettings: AiaSettings = {
  ownerName: 'Acme Owner', ownerAddress: '1 Owner St',
  architectName: 'Bob Architect', architectAddress: '2 Arch Ave',
  contractDate: '2026-01-01', ownerProjectNumber: 'OWN-1', architectProjectNumber: 'ARC-1',
  contractFor: 'General Construction',
};

const ctx: AiaExportCtx = {
  projectName: 'Test Project',
  contractor: 'GC Builders Inc',
  company: { name: 'My Co', address: '3 Co Blvd', phone: '555', email: 'a@b.com' },
  aiaSettings, app, sovLines, g702, g703,
};

// The stub ctx has 2 contract lines + 1 change-order line. Contract items start
// at row 11, so the dynamic anchors are:
const N = 2; // contract lines
const M = 1; // change-order lines
const CONTRACT_START = 11;
const CONTRACT_TOTAL_ROW = CONTRACT_START + N;          // 13
const CO_LABEL_ROW = CONTRACT_TOTAL_ROW + 2;            // 15
const CO_HEADER_TOP = CO_LABEL_ROW + 2;                 // 17
const CO_START = CO_HEADER_TOP + 4;                     // 21
const CO_TOTAL_ROW = CO_START + M;                      // 22
const GRAND_ROW = CO_TOTAL_ROW + 1;                     // 23

// exceljs stores a formula cell as { formula, result? }; extract the formula.
const formulaOf = (cell: unknown): string | undefined =>
  cell && typeof cell === 'object' && 'formula' in (cell as Record<string, unknown>)
    ? String((cell as { formula: string }).formula)
    : undefined;

describe('buildAiaWorkbook', () => {
  it('creates a workbook with sheets G702 then G703 (G702 first)', async () => {
    const wb = await buildAiaWorkbook(ctx);
    expect(wb.getWorksheet('G702')).toBeDefined();
    expect(wb.getWorksheet('G703')).toBeDefined();
    expect(wb.worksheets.map((w) => w.name)).toEqual(['G702', 'G703']);
  });

  it('G703 contract TOTALS row sits at 11 + N (dynamic) with SUM formulas', async () => {
    const wb = await buildAiaWorkbook(ctx);
    const ws = wb.getWorksheet('G703')!;

    expect(ws.getCell(`B${CONTRACT_TOTAL_ROW}`).value).toBe('TOTALS');
    expect(formulaOf(ws.getCell(`C${CONTRACT_TOTAL_ROW}`).value))
      .toBe(`SUM(C${CONTRACT_START}:C${CONTRACT_TOTAL_ROW - 1})`);
    expect(formulaOf(ws.getCell(`G${CONTRACT_TOTAL_ROW}`).value))
      .toBe(`SUM(G${CONTRACT_START}:G${CONTRACT_TOTAL_ROW - 1})`);
  });

  it('G703 change-order TOTALS + GRAND TOTAL rows sit at the expected dynamic positions', async () => {
    const wb = await buildAiaWorkbook(ctx);
    const ws = wb.getWorksheet('G703')!;

    expect(ws.getCell(`B${CO_LABEL_ROW}`).value).toBe('Change Orders');
    expect(ws.getCell(`B${CO_TOTAL_ROW}`).value).toBe('TOTALS');
    expect(formulaOf(ws.getCell(`C${CO_TOTAL_ROW}`).value))
      .toBe(`SUM(C${CO_START}:C${CO_TOTAL_ROW - 1})`);

    expect(ws.getCell(`B${GRAND_ROW}`).value).toBe('GRAND TOTAL');
    expect(formulaOf(ws.getCell(`C${GRAND_ROW}`).value))
      .toBe(`C${CONTRACT_TOTAL_ROW}+C${CO_TOTAL_ROW}`);
  });

  it('G703 item rows hold cents/100 inputs and live G/H/I/J formulas', async () => {
    const wb = await buildAiaWorkbook(ctx);
    const ws = wb.getWorksheet('G703')!;

    // First contract line = g703[0] (Mobilization).
    expect(ws.getCell(`B${CONTRACT_START}`).value).toBe('Mobilization');
    expect(ws.getCell(`C${CONTRACT_START}`).value).toBe(g703[0].scheduledValueCents / 100);
    expect(ws.getCell(`D${CONTRACT_START}`).value).toBe(g703[0].previousCents / 100);
    expect(ws.getCell(`E${CONTRACT_START}`).value).toBe(g703[0].thisPeriodCents / 100);
    expect(ws.getCell(`F${CONTRACT_START}`).value).toBe(g703[0].storedCents / 100);
    expect(formulaOf(ws.getCell(`G${CONTRACT_START}`).value))
      .toBe(`D${CONTRACT_START}+E${CONTRACT_START}+F${CONTRACT_START}`);
    expect(formulaOf(ws.getCell(`J${CONTRACT_START}`).value))
      .toBe(`SUM(D${CONTRACT_START}:E${CONTRACT_START})*'G702'!$G$22`);

    // The CO line input sits at CO_START.
    expect(ws.getCell(`B${CO_START}`).value).toBe('Extra door');
    expect(ws.getCell(`C${CO_START}`).value).toBe(g703[2].scheduledValueCents / 100);
  });

  it('G702 carries the inputs and anchors its 9 lines to the dynamic G703 rows', async () => {
    const wb = await buildAiaWorkbook(ctx);
    const ws = wb.getWorksheet('G702')!;

    // Inputs.
    expect(ws.getCell('D6').value).toBe(ctx.contractor);      // G.C. = project contractor
    expect(ws.getCell('B3').value).toBe(ctx.aiaSettings.ownerName); // owner (when entered)
    expect(ws.getCell('B7').value).toBe(ctx.company.name);    // FROM = our company
    expect(ws.getCell('D3').value).toBe(ctx.projectName);     // project
    expect(ws.getCell('H3').value).toBe(app.number);          // application #
    expect(ws.getCell('H6').value).toBe(app.periodTo);        // period to
    expect(ws.getCell('G22').value).toBeCloseTo(app.retainagePercent / 100, 4); // rate

    // Line 1 (ORIGINAL CONTRACT SUM) references the dynamic contract TOTALS C cell.
    expect(formulaOf(ws.getCell('H14').value)).toBe(`'G703'!C${CONTRACT_TOTAL_ROW}`);
    // Line 4 references contract + CO TOTALS G cells.
    expect(formulaOf(ws.getCell('H20').value))
      .toBe(`'G703'!G${CONTRACT_TOTAL_ROW}+'G703'!G${CO_TOTAL_ROW}`);
    // Line 5 (retainage) references contract + CO TOTALS J cells.
    expect(formulaOf(ws.getCell('H22').value))
      .toBe(`'G703'!J${CONTRACT_TOTAL_ROW}+'G703'!J${CO_TOTAL_ROW}`);
  });

  it('leaves the Application No blank for a zero-numbered (blank SOV) app', async () => {
    const wb = await buildAiaWorkbook({ ...ctx, app: { ...ctx.app, number: 0 } });
    const g702 = wb.getWorksheet('G702')!;
    expect(g702.getCell('H3').value).toBe('');
  });

  it('guards H-column % formulas with IFERROR to prevent #DIV/0! on zero sections', async () => {
    // Blank SOV export: no change-order lines, zero CO sums in g702.
    const blankCtx: AiaExportCtx = {
      ...ctx,
      g703: g703.filter((row) => !row.isChangeOrder), // contract only, no COs
      g702: {
        ...ctx.g702,
        changeOrders: { additionsCents: 0, deductionsCents: 0, netCents: 0 },
      },
    };

    const wb = await buildAiaWorkbook(blankCtx);
    const ws = wb.getWorksheet('G703')!;

    // With zero CO lines, the CO TOTALS row will divide by zero (empty section).
    // CO layout: contract section rows 11-12 (2 items), TOTALS 13, then
    // CO-label 15, CO-header 17, CO-start 21, CO-totals (0 items) 21.
    const coZeroTotalRow = CO_START; // when no CO items, TOTALS sits at CO_START

    // Item-row H formula should contain IFERROR.
    const itemFormula = formulaOf(ws.getCell(`H${CONTRACT_START}`).value);
    expect(itemFormula).toContain('IFERROR');
    expect(itemFormula).toContain(`G${CONTRACT_START}/C${CONTRACT_START}`);

    // CO TOTALS-row H formula should also contain IFERROR (protects against C=0).
    const coTotalFormula = formulaOf(ws.getCell(`H${coZeroTotalRow}`).value);
    expect(coTotalFormula).toContain('IFERROR');
  });
});
