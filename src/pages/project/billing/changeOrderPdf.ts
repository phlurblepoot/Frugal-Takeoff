import { jsPDF } from 'jspdf';
import { ChangeOrder, ChangeOrderLine } from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { resolveAccentRgb } from './invoicePdf';

export { resolveAccentRgb };

const fmtQty = (n: number) => String(n);

// Pure data-shaping (unit-tested).
export const coRows = (lines: ChangeOrderLine[]): string[][] =>
  lines.map(l => [
    l.description || '',
    fmtQty(Number(l.qty) || 0),
    formatMoney(Math.round((Number(l.unitPrice) || 0) * 100)),
    formatMoney(Math.round((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * 100)),
  ]);

// Totals block: lump sum row (only when > 0) followed by the bold Total.
export const coTotalsBlock = (totalCents: number, lumpSumCents: number): [string, string][] => {
  const block: [string, string][] = [];
  if (lumpSumCents > 0) block.push(['Lump Sum', formatMoney(lumpSumCents)]);
  block.push(['Total', formatMoney(totalCents)]);
  return block;
};

// "Schedule impact: +N days" (singular for 1), or '' when not set.
export const scheduleImpactLabel = (days: number | null | undefined): string => {
  if (days === null || days === undefined) return '';
  const n = Number(days);
  if (!Number.isFinite(n)) return '';
  return `Schedule impact: +${n} day${Math.abs(n) === 1 ? '' : 's'}`;
};

export interface ChangeOrderPdfContext {
  changeOrder: ChangeOrder;
  projectName: string;
  contractor?: string | null;
  address?: string | null;
  company: { name: string; address?: string; phone?: string; email?: string; logoDataUrl?: string };
  accentRgb?: [number, number, number];
  photoDataUrls: string[]; // pre-fetched (caller resolves each fileId → dataURL)
}

export function buildChangeOrderPdf(ctx: ChangeOrderPdfContext): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const Hp = doc.internal.pageSize.getHeight();
  const M = 48;
  const [ar, ag, ab] = ctx.accentRgb ?? [37, 99, 235];
  const co = ctx.changeOrder;
  let y = M;

  // (1) Header: logo + company block (left)
  let leftY = y;
  if (ctx.company.logoDataUrl) {
    try { doc.addImage(ctx.company.logoDataUrl, 'PNG', M, leftY, 110, 44); leftY += 52; } catch { /* skip bad logo */ }
  }
  doc.setFont('helvetica', 'bold').setFontSize(13).setTextColor(20, 20, 20);
  doc.text(ctx.company.name || 'Change Order Request', M, leftY + 4); leftY += 16;
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90, 90, 90);
  for (const line of [ctx.company.address, [ctx.company.phone, ctx.company.email].filter(Boolean).join('  ·  ')].filter(Boolean)) {
    doc.text(String(line), M, leftY); leftY += 12;
  }

  // (1) Header: CHANGE ORDER REQUEST title + meta (right)
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(ar, ag, ab);
  doc.text('CHANGE ORDER REQUEST', W - M, y + 16, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(60, 60, 60);
  let metaY = y + 36;
  doc.text(`No: CO-${co.number ?? ''}`, W - M, metaY, { align: 'right' }); metaY += 14;
  if (co.date) { doc.text(`Date: ${new Date(co.date).toLocaleDateString()}`, W - M, metaY, { align: 'right' }); metaY += 14; }
  const impact = scheduleImpactLabel(co.scheduleImpactDays);
  if (impact) { doc.text(impact, W - M, metaY, { align: 'right' }); metaY += 14; }

  y = Math.max(leftY, metaY) + 20;

  // (2) Bill To
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(120, 120, 120);
  doc.text('BILL TO', M, y); y += 14;
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
  for (const line of [ctx.contractor, ctx.projectName, ctx.address].filter(Boolean)) {
    doc.text(String(line), M, y); y += 13;
  }
  y += 14;

  // (3) Description block (narrative, wrapped)
  if (co.description) {
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(120, 120, 120);
    doc.text('DESCRIPTION', M, y); y += 14;
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
    const lines = doc.splitTextToSize(co.description, W - 2 * M);
    doc.text(lines, M, y); y += lines.length * 13 + 14;
  }

  const xQty = 320, xUnit = 396, xAmt = W - M;

  // (4) Line-item table (only if any lines)
  if (co.lines.length) {
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(60, 60, 60);
    doc.text('DESCRIPTION', M, y);
    doc.text('QTY', xQty, y, { align: 'right' });
    doc.text('UNIT', xUnit, y, { align: 'right' });
    doc.text('AMOUNT', xAmt, y, { align: 'right' });
    y += 6;
    doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(M, y, W - M, y);
    y += 16;

    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
    for (const [desc, qty, unit, amount] of coRows(co.lines)) {
      doc.text(desc, M, y, { maxWidth: 260 });
      doc.text(qty, xQty, y, { align: 'right' });
      doc.text(unit, xUnit, y, { align: 'right' });
      doc.text(amount, xAmt, y, { align: 'right' });
      y += 18;
    }
    doc.setDrawColor(210, 210, 210).setLineWidth(0.5).line(M, y, W - M, y);
    y += 8;
  }

  // (5) Lump sum + (6) Total (bottom-right)
  doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(xUnit - 20, y, W - M, y);
  y += 16;
  for (const [label, value] of coTotalsBlock(co.totalCents, co.lumpSumCents)) {
    const bold = label === 'Total';
    doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(bold ? 12 : 10).setTextColor(30, 30, 30);
    doc.text(label, xUnit, y, { align: 'right' });
    doc.text(value, xAmt, y, { align: 'right' });
    y += bold ? 18 : 15;
  }
  y += 16;

  // (7) Signature / acceptance block
  if (y + 60 > Hp - M) { doc.addPage(); y = M; }
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
  doc.text('Accepted by (Owner): ______________________________    Date: ______________', M, y); y += 28;
  doc.text('Submitted by (Contractor): _________________________    Date: ______________', M, y); y += 18;

  // (8) Photos appended as pages (fresh page after the signature block).
  if (ctx.photoDataUrls.length) {
    doc.addPage();
    y = M;
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
    doc.text('Photos', M, y); y += 14;
    const cellW = (W - 2 * M - 12) / 2, cellH = 150;
    let col = 0;
    for (const url of ctx.photoDataUrls) {
      if (y + cellH > Hp - M) { doc.addPage(); y = M; col = 0; }
      const x = M + col * (cellW + 12);
      try { doc.addImage(url, 'JPEG', x, y, cellW, cellH, undefined, 'FAST'); } catch { /* skip bad image */ }
      col++;
      if (col === 2) { col = 0; y += cellH + 12; }
    }
  }

  return doc.output('arraybuffer') as unknown as Uint8Array;
}
