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
  company: { name: 'My Co', address: '3 Co Blvd', phone: '555', email: 'a@b.com' },
  aiaSettings, app, sovLines, g702, g703,
};

describe('buildAiaWorkbook', () => {
  it('creates a workbook with G702 and G703 sheets', async () => {
    const wb = await buildAiaWorkbook(ctx);
    expect(wb.getWorksheet('G702')).toBeDefined();
    expect(wb.getWorksheet('G703')).toBeDefined();
  });

  it('G703 has one row per g703 line plus a grand-totals row, reconciling to G702', async () => {
    const wb = await buildAiaWorkbook(ctx);
    const ws = wb.getWorksheet('G703')!;

    // Find the GRAND TOTALS row by scanning column B.
    let totalsRow = -1;
    let dataRows = 0;
    ws.eachRow((row, n) => {
      const b = row.getCell('B').value;
      if (b === 'GRAND TOTALS') totalsRow = n;
    });
    expect(totalsRow).toBeGreaterThan(0);

    // Data rows = the three header-grid rows above the totals row whose item/desc
    // match our inputs. Count rows where column C is a number and it's not the
    // totals row.
    for (let n = 1; n < totalsRow; n++) {
      const c = ws.getCell(`C${n}`).value;
      const b = ws.getCell(`B${n}`).value;
      if (typeof c === 'number' && b !== 'GRAND TOTALS' &&
          (b === 'Mobilization' || b === 'Framing' || b === 'Extra door')) {
        dataRows++;
      }
    }
    expect(dataRows).toBe(3);

    // Grand totals reconcile to G702: ΣC=L3, ΣG=L4, ΣRet=L5 (dollars).
    expect(ws.getCell(`C${totalsRow}`).value).toBeCloseTo(g702.L3contractSumToDateCents / 100, 2);
    expect(ws.getCell(`G${totalsRow}`).value).toBeCloseTo(g702.L4totalCompletedStoredCents / 100, 2);
    expect(ws.getCell(`J${totalsRow}`).value).toBeCloseTo(g702.L5retainageCents / 100, 2);
  });

  it('G702 current payment due cell equals L8 in dollars', async () => {
    const wb = await buildAiaWorkbook(ctx);
    const ws = wb.getWorksheet('G702')!;

    // Find the "8. CURRENT PAYMENT DUE" row, read its money cell (column F).
    let found = -1;
    ws.eachRow((row, n) => {
      const a = row.getCell('A').value;
      if (typeof a === 'string' && a.startsWith('8. CURRENT PAYMENT DUE')) found = n;
    });
    expect(found).toBeGreaterThan(0);
    expect(ws.getCell(`F${found}`).value).toBeCloseTo(g702.L8currentPaymentDueCents / 100, 2);
  });
});
