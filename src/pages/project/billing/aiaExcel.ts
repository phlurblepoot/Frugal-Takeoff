// src/pages/project/billing/aiaExcel.ts
//
// Faithful recreation of the AIA G702 (Application and Certificate for Payment)
// and G703 (Continuation Sheet) documents as a single .xlsx workbook (two
// sheets) built with exceljs. This is the DEFAULT export path.
//
// A separate "template-fill" export mode is intended to live beside this one in
// the future; keep `buildAiaWorkbook` a pure, side-effect-free builder so an
// alternate path (e.g. `buildAiaWorkbookFromTemplate`) can be added without
// touching the download plumbing in `exportAiaXlsx`.
//
// Money is stored as INTEGER CENTS everywhere; convert to dollars ONLY at the
// cell value (cents / 100) paired with a `$#,##0.00` number format.

import ExcelJS from 'exceljs';
import type { AiaSettings, AiaPayApp, AiaSovLine, AiaG702, AiaG703Row } from '../../../utils/store';

export interface AiaExportCtx {
  projectName: string;
  company: { name?: string; address?: string; phone?: string; email?: string; logoDataUrl?: string };
  aiaSettings: AiaSettings;
  app: AiaPayApp;
  sovLines: AiaSovLine[];
  g702: AiaG702;
  g703: AiaG703Row[];
}

const MONEY_FMT = '$#,##0.00';
const PCT_FMT = '0%';

// Cents -> dollars; the single place the conversion happens.
const dollars = (cents: number): number => (cents || 0) / 100;

// Standard thin border on all four sides.
const THIN = { style: 'thin' as const };
const boxBorder = (): Partial<ExcelJS.Borders> => ({ top: THIN, left: THIN, bottom: THIN, right: THIN });

function setCell(
  ws: ExcelJS.Worksheet,
  addr: string,
  value: ExcelJS.CellValue,
  opts: {
    bold?: boolean;
    money?: boolean;
    pct?: boolean;
    border?: boolean;
    align?: 'left' | 'center' | 'right';
    wrap?: boolean;
    size?: number;
    fill?: string;
  } = {},
): ExcelJS.Cell {
  const cell = ws.getCell(addr);
  cell.value = value;
  if (opts.money) cell.numFmt = MONEY_FMT;
  if (opts.pct) cell.numFmt = PCT_FMT;
  cell.font = { bold: !!opts.bold, size: opts.size ?? 10, name: 'Arial' };
  if (opts.border) cell.border = boxBorder();
  cell.alignment = {
    horizontal: opts.align ?? (opts.money || opts.pct ? 'right' : 'left'),
    vertical: 'middle',
    wrapText: !!opts.wrap,
  };
  if (opts.fill) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
  }
  return cell;
}

// US Letter page setup, fit-to-width.
function applyPageSetup(ws: ExcelJS.Worksheet, landscape = false): void {
  ws.pageSetup = {
    // Letter == 1; absent from exceljs's PaperSize enum (it lists non-default
    // sizes only), so cast the literal through the enum type.
    paperSize: 1 as unknown as ExcelJS.PaperSize, // Letter
    orientation: landscape ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
  };
}

// ---------------------------------------------------------------------------
// G702 — Application and Certificate for Payment
// ---------------------------------------------------------------------------
function buildG702(wb: ExcelJS.Workbook, ctx: AiaExportCtx): void {
  const ws = wb.addWorksheet('G702');
  applyPageSetup(ws, false);

  // Column widths (A..F) sized for a two-column header + label/value cert block.
  ws.columns = [
    { width: 22 }, // A
    { width: 26 }, // B
    { width: 14 }, // C
    { width: 22 }, // D
    { width: 16 }, // E
    { width: 16 }, // F
  ];

  const a = ctx.aiaSettings;
  const g = ctx.g702;
  const app = ctx.app;

  let r = 1;

  // Optional logo in the top-left header band. Never throw on a bad image.
  if (ctx.company.logoDataUrl) {
    try {
      const m = /^data:(image\/(png|jpeg|jpg|gif));base64,(.+)$/i.exec(ctx.company.logoDataUrl);
      if (m) {
        const ext = m[2].toLowerCase() === 'jpg' ? 'jpeg' : (m[2].toLowerCase() as 'png' | 'jpeg' | 'gif');
        const imgId = wb.addImage({ base64: m[3], extension: ext });
        ws.addImage(imgId, { tl: { col: 0, row: 0 }, ext: { width: 140, height: 50 } });
        r = 4; // leave room for the logo
      }
    } catch { /* skip bad logo */ }
  }

  // Title.
  ws.mergeCells(`A${r}:F${r}`);
  setCell(ws, `A${r}`, 'APPLICATION AND CERTIFICATE FOR PAYMENT', { bold: true, align: 'center', size: 14 });
  r++;
  ws.mergeCells(`A${r}:F${r}`);
  setCell(ws, `A${r}`, 'AIA Document G702', { align: 'center', size: 9 });
  r += 2;

  const headerRow = (label: string, value: string, label2?: string, value2?: string) => {
    setCell(ws, `A${r}`, label, { bold: true });
    ws.mergeCells(`B${r}:C${r}`);
    setCell(ws, `B${r}`, value);
    if (label2 !== undefined) {
      setCell(ws, `D${r}`, label2, { bold: true });
      ws.mergeCells(`E${r}:F${r}`);
      setCell(ws, `E${r}`, value2 ?? '');
    }
    r++;
  };

  const contractorBlock = [a.contractFor ? `For: ${a.contractFor}` : '']
    .filter(Boolean)
    .join('\n');

  headerRow('TO OWNER:', a.ownerName ?? '', 'FROM CONTRACTOR:', ctx.company.name ?? '');
  headerRow('', a.ownerAddress ?? '', '', ctx.company.address ?? '');
  headerRow('PROJECT:', ctx.projectName, '', [ctx.company.phone, ctx.company.email].filter(Boolean).join('  '));
  headerRow('VIA ARCHITECT:', a.architectName ?? '', 'CONTRACT FOR:', a.contractFor ?? '');
  headerRow('', a.architectAddress ?? '', '', contractorBlock || '');
  headerRow('APPLICATION NO:', String(app.number), 'PERIOD TO:', app.periodTo ?? '');
  headerRow('APPLICATION DATE:', app.applicationDate ?? '', 'CONTRACT DATE:', a.contractDate ?? '');
  headerRow('OWNER PROJECT NO:', a.ownerProjectNumber ?? '', 'ARCHITECT PROJECT NO:', a.architectProjectNumber ?? '');
  r++;

  // Certificate lines 1..9.
  setCell(ws, `A${r}`, "CONTRACTOR'S APPLICATION FOR PAYMENT", { bold: true });
  r++;

  const certRow = (label: string, cents: number, opts: { bold?: boolean; sub?: boolean } = {}) => {
    const labelCol = opts.sub ? `B${r}` : `A${r}`;
    if (opts.sub) ws.mergeCells(`B${r}:E${r}`);
    else ws.mergeCells(`A${r}:E${r}`);
    setCell(ws, labelCol, label, { bold: opts.bold, border: true });
    setCell(ws, `F${r}`, dollars(cents), { money: true, bold: opts.bold, border: true });
    r++;
  };

  certRow('1. ORIGINAL CONTRACT SUM', g.L1originalContractCents);
  certRow('2. NET CHANGE BY CHANGE ORDERS', g.L2changeOrdersCents);
  certRow('3. CONTRACT SUM TO DATE (Line 1 ± 2)', g.L3contractSumToDateCents, { bold: true });
  certRow('4. TOTAL COMPLETED & STORED TO DATE (Column G on G703)', g.L4totalCompletedStoredCents);
  certRow('5. RETAINAGE:', g.L5retainageCents);
  certRow(`a. ${app.retainagePercent}% of Completed Work (Columns D + E on G703)`, g.L5aRetainageWorkCents, { sub: true });
  certRow(`b. ${app.storedRetainagePercent}% of Stored Material (Column F on G703)`, g.L5bRetainageStoredCents, { sub: true });
  certRow('Total Retainage (Lines 5a + 5b)', g.L5retainageCents, { sub: true });
  certRow('6. TOTAL EARNED LESS RETAINAGE (Line 4 less Line 5 Total)', g.L6earnedLessRetainageCents);
  certRow('7. LESS PREVIOUS CERTIFICATES FOR PAYMENT (Line 6 from prior Certificate)', g.L7lessPreviousCents);
  // Line 8 — emphasized current payment due.
  ws.mergeCells(`A${r}:E${r}`);
  setCell(ws, `A${r}`, '8. CURRENT PAYMENT DUE', { bold: true, border: true, fill: 'FFFFF2CC' });
  setCell(ws, `F${r}`, dollars(g.L8currentPaymentDueCents), { money: true, bold: true, border: true, size: 12, fill: 'FFFFF2CC' });
  r++;
  certRow('9. BALANCE TO FINISH, PLUS RETAINAGE (Line 3 less Line 6)', g.L9balanceToFinishCents);
  r++;

  // Change Order summary box.
  setCell(ws, `A${r}`, 'CHANGE ORDER SUMMARY', { bold: true });
  r++;
  const coRow = (label: string, cents: number, bold = false) => {
    ws.mergeCells(`A${r}:E${r}`);
    setCell(ws, `A${r}`, label, { bold, border: true });
    setCell(ws, `F${r}`, dollars(cents), { money: true, bold, border: true });
    r++;
  };
  coRow('Total additions', g.changeOrders.additionsCents);
  coRow('Total deductions', g.changeOrders.deductionsCents);
  coRow('NET CHANGE BY CHANGE ORDERS', g.changeOrders.netCents, true);
  r++;

  // Contractor's certification.
  ws.mergeCells(`A${r}:F${r + 3}`);
  setCell(
    ws,
    `A${r}`,
    "The undersigned Contractor certifies that to the best of the Contractor's knowledge, information and belief the Work covered by this Application for Payment has been completed in accordance with the Contract Documents, that all amounts have been paid by the Contractor for Work for which previous Certificates for Payment were issued and payments received from the Owner, and that current payment shown herein is now due.",
    { wrap: true, size: 9 },
  );
  r += 4;

  setCell(ws, `A${r}`, 'CONTRACTOR:', { bold: true });
  r += 2;
  setCell(ws, `A${r}`, 'By: ____________________________', {});
  setCell(ws, `D${r}`, 'Date: ____________________', {});
  r += 2;
  setCell(ws, `A${r}`, 'State of: ____________________', {});
  setCell(ws, `D${r}`, 'County of: ____________________', {});
  r++;
  setCell(ws, `A${r}`, 'Subscribed and sworn to before me this ______ day of ____________, ________', { size: 9 });
  r++;
  setCell(ws, `A${r}`, 'Notary Public: ____________________________', {});
  setCell(ws, `D${r}`, 'My Commission expires: ____________', {});
  r += 2;

  // Architect's Certificate for Payment.
  setCell(ws, `A${r}`, "ARCHITECT'S CERTIFICATE FOR PAYMENT", { bold: true });
  r++;
  ws.mergeCells(`A${r}:F${r + 3}`);
  setCell(
    ws,
    `A${r}`,
    "In accordance with the Contract Documents, based on on-site observations and the data comprising this application, the Architect certifies to the Owner that to the best of the Architect's knowledge, information and belief the Work has progressed as indicated, the quality of the Work is in accordance with the Contract Documents, and the Contractor is entitled to payment of the AMOUNT CERTIFIED.",
    { wrap: true, size: 9 },
  );
  r += 4;
  setCell(ws, `A${r}`, 'AMOUNT CERTIFIED', { bold: true });
  setCell(ws, `C${r}`, '$ ____________________', { bold: true });
  r++;
  setCell(
    ws,
    `A${r}`,
    '(Attach explanation if amount certified differs from the amount applied. Initial all figures on this Application and on the Continuation Sheet that are changed to conform with the amount certified.)',
    { size: 8, wrap: true },
  );
  ws.mergeCells(`A${r}:F${r}`);
  r += 2;
  setCell(ws, `A${r}`, 'ARCHITECT:', { bold: true });
  r += 2;
  setCell(ws, `A${r}`, 'By: ____________________________', {});
  setCell(ws, `D${r}`, 'Date: ____________________', {});
}

// ---------------------------------------------------------------------------
// G703 — Continuation Sheet
// ---------------------------------------------------------------------------
function buildG703(wb: ExcelJS.Workbook, ctx: AiaExportCtx): void {
  const ws = wb.addWorksheet('G703');
  applyPageSetup(ws, true); // landscape helps the wide grid

  const app = ctx.app;
  const a = ctx.aiaSettings;

  // 10 columns: A..J.
  ws.columns = [
    { width: 10 }, // A item no
    { width: 36 }, // B description
    { width: 16 }, // C scheduled value
    { width: 16 }, // D previous
    { width: 16 }, // E this period
    { width: 16 }, // F stored
    { width: 18 }, // G total to date
    { width: 8 },  // H % (G/C)
    { width: 16 }, // I balance to finish
    { width: 14 }, // J retainage
  ];

  let r = 1;
  ws.mergeCells(`A${r}:J${r}`);
  setCell(ws, `A${r}`, 'CONTINUATION SHEET', { bold: true, align: 'center', size: 14 });
  r++;
  ws.mergeCells(`A${r}:J${r}`);
  setCell(ws, `A${r}`, 'AIA Document G703', { align: 'center', size: 9 });
  r++;
  ws.mergeCells(`A${r}:E${r}`);
  setCell(ws, `A${r}`, `PROJECT: ${ctx.projectName}`, { size: 9 });
  setCell(ws, `F${r}`, `APPLICATION NO: ${app.number}`, { size: 9 });
  ws.mergeCells(`F${r}:G${r}`);
  setCell(ws, `H${r}`, `APPLICATION DATE: ${app.applicationDate ?? ''}`, { size: 9 });
  ws.mergeCells(`H${r}:J${r}`);
  r++;
  ws.mergeCells(`A${r}:E${r}`);
  setCell(ws, `A${r}`, `CONTRACT DATE: ${a.contractDate ?? ''}`, { size: 9 });
  setCell(ws, `F${r}`, `PERIOD TO: ${app.periodTo ?? ''}`, { size: 9 });
  ws.mergeCells(`F${r}:J${r}`);
  r += 2;

  // Header row.
  const headerRowNum = r;
  const headers: [string, string][] = [
    ['A', 'ITEM NO.'],
    ['B', 'DESCRIPTION OF WORK'],
    ['C', 'SCHEDULED VALUE'],
    ['D', 'WORK COMPLETED — FROM PREVIOUS APPLICATION (D+E)'],
    ['E', 'THIS PERIOD'],
    ['F', 'MATERIALS PRESENTLY STORED'],
    ['G', 'TOTAL COMPLETED AND STORED TO DATE (D+E+F)'],
    ['H', '% (G/C)'],
    ['I', 'BALANCE TO FINISH (C-G)'],
    ['J', 'RETAINAGE'],
  ];
  ws.getRow(headerRowNum).height = 48;
  for (const [col, label] of headers) {
    setCell(ws, `${col}${headerRowNum}`, label, {
      bold: true, border: true, align: 'center', wrap: true, size: 9, fill: 'FFE7E6E6',
    });
  }
  r++;

  // Data rows.
  let sumC = 0, sumD = 0, sumE = 0, sumF = 0, sumG = 0, sumBal = 0, sumRet = 0;
  for (const row of ctx.g703) {
    sumC += row.scheduledValueCents;
    sumD += row.previousCents;
    sumE += row.thisPeriodCents;
    sumF += row.storedCents;
    sumG += row.totalToDateCents;
    sumBal += row.balanceToFinishCents;
    sumRet += row.retainageCents;

    // % (G/C): prefer computing G/C so the printed % always matches the grid;
    // fall back to the row's stored percentComplete when scheduled value is 0.
    const pct = row.scheduledValueCents > 0
      ? row.totalToDateCents / row.scheduledValueCents
      : (row.percentComplete || 0) / 100;

    setCell(ws, `A${r}`, row.itemNo ?? '', { border: true, align: 'center' });
    setCell(ws, `B${r}`, row.description, { border: true, wrap: true });
    setCell(ws, `C${r}`, dollars(row.scheduledValueCents), { money: true, border: true });
    setCell(ws, `D${r}`, dollars(row.previousCents), { money: true, border: true });
    setCell(ws, `E${r}`, dollars(row.thisPeriodCents), { money: true, border: true });
    setCell(ws, `F${r}`, dollars(row.storedCents), { money: true, border: true });
    setCell(ws, `G${r}`, dollars(row.totalToDateCents), { money: true, border: true });
    setCell(ws, `H${r}`, pct, { pct: true, border: true, align: 'center' });
    setCell(ws, `I${r}`, dollars(row.balanceToFinishCents), { money: true, border: true });
    setCell(ws, `J${r}`, dollars(row.retainageCents), { money: true, border: true });
    r++;
  }

  // Grand totals row — MUST reconcile to G702: ΣC=L3, ΣG=L4, ΣRet=L5.
  const totalPct = sumC > 0 ? sumG / sumC : 0;
  setCell(ws, `A${r}`, '', { border: true });
  setCell(ws, `B${r}`, 'GRAND TOTALS', { bold: true, border: true });
  setCell(ws, `C${r}`, dollars(sumC), { money: true, bold: true, border: true });
  setCell(ws, `D${r}`, dollars(sumD), { money: true, bold: true, border: true });
  setCell(ws, `E${r}`, dollars(sumE), { money: true, bold: true, border: true });
  setCell(ws, `F${r}`, dollars(sumF), { money: true, bold: true, border: true });
  setCell(ws, `G${r}`, dollars(sumG), { money: true, bold: true, border: true });
  setCell(ws, `H${r}`, totalPct, { pct: true, bold: true, border: true, align: 'center' });
  setCell(ws, `I${r}`, dollars(sumBal), { money: true, bold: true, border: true });
  setCell(ws, `J${r}`, dollars(sumRet), { money: true, bold: true, border: true });
}

// Builds the full two-sheet workbook. Pure builder — no DOM / download here so
// an alternate (template-fill) builder can sit beside it.
export async function buildAiaWorkbook(ctx: AiaExportCtx): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = ctx.company.name ?? 'Frugal Takeoff';
  wb.created = new Date();
  buildG702(wb, ctx);
  buildG703(wb, ctx);
  return wb;
}

function sanitizeFilename(name: string): string {
  return (name || 'project').replace(/[^a-zA-Z0-9 _.-]+/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'project';
}

// Builds the workbook and triggers a browser download.
export async function exportAiaXlsx(ctx: AiaExportCtx): Promise<void> {
  const wb = await buildAiaWorkbook(ctx);
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `AIA-${sanitizeFilename(ctx.projectName)}-App${ctx.app.number}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
