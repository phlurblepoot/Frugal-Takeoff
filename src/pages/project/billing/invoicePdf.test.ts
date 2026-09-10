import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { invoiceRows, invoiceTotalsBlock, buildInvoicePdf, appendPdfAttachments } from './invoicePdf';

describe('invoice pdf data shaping', () => {
  it('invoiceRows maps lines to [desc, qty, unit, amount] display strings', () => {
    const rows = invoiceRows([{ description: 'Drywall', qty: 2, unitPrice: 50 } as any]);
    expect(rows[0]).toEqual(['Drywall', '2', '$50.00', '$100.00']);
  });
  it('invoiceTotalsBlock formats total/paid/balance from cents', () => {
    expect(invoiceTotalsBlock(12550, 5000)).toEqual([
      ['Total', '$125.50'], ['Paid', '$50.00'], ['Balance Due', '$75.50'],
    ]);
  });
});

// A 1x1 JPEG — jsPDF needs a real decodable image to embed.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const makePdf = async (n: number) => {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage();
  return d.save();
};

const baseInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv1', projectId: 'p1', number: 'INV-1', date: null, status: 'draft', terms: null, notes: null,
  version: 1, createdAt: 0, updatedAt: 0, lines: [], payments: [], photos: [], attachments: [],
  totalCents: 0, paidCents: 0, balanceCents: 0, ...overrides,
}) as any;

const letterhead = { brandRgb: [153, 203, 56] as [number, number, number], company: { name: 'Big Bear' } };

describe('buildInvoicePdf — photo pages', () => {
  it('appends no extra page when there are no photos', async () => {
    const bytes = buildInvoicePdf({ invoice: baseInvoice(), projectName: 'Job', letterhead });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it('appends a photos page (page count grows) when photoDataUrls is non-empty', async () => {
    const withoutPhotos = await PDFDocument.load(buildInvoicePdf({ invoice: baseInvoice(), projectName: 'Job', letterhead }));
    const withPhotos = await PDFDocument.load(
      buildInvoicePdf({ invoice: baseInvoice(), projectName: 'Job', letterhead, photoDataUrls: [JPEG, JPEG, JPEG] }),
    );
    expect(withPhotos.getPageCount()).toBeGreaterThan(withoutPhotos.getPageCount());
  });
});

describe('appendPdfAttachments', () => {
  it('merges attachment page counts onto the base document, in order', async () => {
    const base = await makePdf(1);
    const a = await makePdf(2);
    const b = await makePdf(3);
    const out = await appendPdfAttachments(base, [a, b]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1 + 2 + 3);
  });

  it('returns the base unchanged when there are no attachments', async () => {
    const base = await makePdf(1);
    const out = await appendPdfAttachments(base, []);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
  });

  it('skips an unreadable attachment and keeps the rest', async () => {
    const base = await makePdf(1);
    const good = await makePdf(2);
    const garbage = new TextEncoder().encode('not a pdf').buffer;
    const out = await appendPdfAttachments(base, [garbage, good]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1 + 2); // garbage skipped, good merged
  });
});
