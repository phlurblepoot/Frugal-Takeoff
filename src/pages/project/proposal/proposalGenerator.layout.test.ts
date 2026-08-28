// src/pages/project/proposal/proposalGenerator.layout.test.ts
// Layout contract for the snapshot renderer: which sections exist, what order
// they come in, and which page each one STARTS on. Placement is asserted
// through the generator's `sections` map (1-based page index per section) plus
// the final page count; `textByPage` below adds the drawn strings for the
// assertions (section bands) that a page index alone can't express.
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { generateProposalPdf, proposalFileName } from './proposalGenerator';
import type { ProposalRenderInput } from './proposalGenerator';
import type { Proposal } from '../../../utils/store';
import type { Project } from '../../../types';

const project = { id: 'p', name: 'Dania Beach', createdAt: 0, pages: [], takeoffs: [], address: '1 Main St' } as unknown as Project;

const line = (o: Partial<Proposal['lines'][number]>) => ({
  id: 'l', sortOrder: 0, kind: 'manual', takeoffId: null, description: 'x',
  amountCents: 100, derivedAmountCents: null, measurementSummary: null, isAlternate: false, ...o,
}) as Proposal['lines'][number];

const base = (o: Partial<Proposal> = {}): Proposal => ({
  id: 'pr', projectId: 'p', number: 7, revisedFromId: null, revisedFromNumber: null, status: 'draft', legacy: false,
  title: null, validUntil: null, fontFamily: 'helvetica', coverNotes: '', terms: '', inclusions: [], exclusions: [], paymentSchedule: null,
  showGrandTotal: true, includeCostDetail: false, includeSignature: false, highlightQuality: 'best',
  fileId: null, signedFileId: null, sentAt: null, sentTo: null, acceptedAt: null, declinedAt: null,
  version: 1, createdBy: null, createdAt: 0, updatedAt: 0,
  totalCents: 0, alternateCount: 0, hasOverride: false, photoCount: 0, attachmentCount: 0,
  lines: [], photos: [], attachments: [], ...o,
});

const input = (proposal: Proposal, extra: Partial<ProposalRenderInput> = {}): ProposalRenderInput => ({
  proposal, project, takeoffTotals: [], currentPageIds: new Set(),
  letterhead: { brandRgb: [153, 203, 56], company: { name: 'Big Bear' } },
  photos: [], attachments: [], includeHighlights: false, ...extra,
});

// jsPDF writes uncompressed content streams and pdf-lib copies them verbatim
// into the merged file, so the drawn strings survive in the output bytes. The
// "Page N of M" stamp is written last on every body page, which makes it a
// reliable delimiter: everything before it belongs to that page.
const textByPage = (bytes: ArrayBuffer): Map<number, string[]> => {
  const raw = Buffer.from(bytes).toString('latin1');
  const texts = [...raw.matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)]
    .map(m => m[1].replace(/\\([()\\])/g, '$1'));
  const byPage = new Map<number, string[]>();
  let current: string[] = [];
  for (const t of texts) {
    const stamp = /^Page (\d+) of \d+$/.exec(t);
    if (stamp) { byPage.set(Number(stamp[1]), current); current = []; }
    else current.push(t);
  }
  return byPage;
};

const BAND = /^(Pricing|Inclusions & Exclusions|Notes|Alternates|Cost Detail|Terms & Conditions|Photos)( \(cont\.\))?$/;
/** The section band printed at the top of a given 1-based page, if any. */
const bandOnPage = (bytes: ArrayBuffer, page: number): string | undefined =>
  textByPage(bytes).get(page)?.find(t => BAND.test(t));

const pages = async (bytes: ArrayBuffer) => (await PDFDocument.load(bytes)).getPageCount();
const makePdf = async (n: number) => {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage();
  const b = await d.save();
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

// A 1x1 JPEG — jsPDF needs a real decodable image to embed.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

describe('proposal layout', () => {
  it('names the file from project + date, never the number', () => {
    expect(proposalFileName(project, new Date(2026, 7, 28, 12, 0, 0))).toBe('Proposal – Dania Beach – 2026-08-28');
  });

  it('a bare proposal is a single cover/pricing page', async () => {
    const { pdfBytes, suggestedName, sections } = await generateProposalPdf(input(base({ lines: [line({})] })));
    expect(await pages(pdfBytes)).toBe(1);
    expect(suggestedName).toMatch(/^Proposal – Dania Beach – \d{4}-\d{2}-\d{2}$/);
    expect(suggestedName).not.toContain('#7');
    expect(sections.grandTotal).toBe(1);
  });

  it('omits the grand total box when showGrandTotal is false', async () => {
    const { sections } = await generateProposalPdf(input(base({ lines: [line({})], showGrandTotal: false })));
    expect(sections.grandTotal).toBeUndefined();
  });

  it('alternates add a separate page; attachments append their pages untouched', async () => {
    const p = base({ lines: [line({ id: 'a' }), line({ id: 'b', isAlternate: true })] });
    const plain = await generateProposalPdf(input(p));
    expect(await pages(plain.pdfBytes)).toBe(2);
    expect(plain.sections.alternates).toBe(2);

    const withAtt = await generateProposalPdf(input(p, { attachments: [await makePdf(3), await makePdf(2)] }));
    expect(await pages(withAtt.pdfBytes)).toBe(7);
    expect(withAtt.sections.attachmentsStart).toBe(3);
  });

  it('skips an unreadable attachment instead of failing the whole render', async () => {
    const p = base({ lines: [line({})] });
    const junk = new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer;
    const { pdfBytes } = await generateProposalPdf(input(p, { attachments: [junk, await makePdf(2)] }));
    expect(await pages(pdfBytes)).toBe(3); // cover/pricing + the 2 readable pages
  });

  it('long notes flow onto extra pages after the grand total (grand total stays on page 1)', async () => {
    const notes = Array.from({ length: 400 }, (_, i) => `Note line ${i} lorem ipsum dolor sit amet`).join('\n');
    const p = base({ lines: [line({})], coverNotes: notes });
    const { pdfBytes, sections } = await generateProposalPdf(input(p));
    expect(await pages(pdfBytes)).toBeGreaterThan(2);
    // The total is the reader's headline: it must precede the notes, on page 1.
    expect(sections.grandTotal).toBe(1);
    expect(sections.notes).toBe(1);
  });

  it('a section pushed onto a fresh page by its opening ensure() is banded plainly, not "(cont.)"', async () => {
    // 60 price lines fill pages 1-2 and spill the total onto page 3, where the
    // inclusions still fit; the notes then open with a page break onto page 5.
    // That page is where Notes STARTS — it must not claim to be a continuation.
    const p = base({
      lines: Array.from({ length: 60 }, (_, i) => line({ id: `l${i}`, description: `Item number ${i}` })),
      inclusions: Array.from({ length: 30 }, (_, i) => `Inclusion ${i}`),
      exclusions: ['Paint'],
      coverNotes: 'Hello there.',
    });
    const { pdfBytes, sections } = await generateProposalPdf(input(p));

    expect(bandOnPage(pdfBytes, sections.notes)).toBe('Notes');
    // Pricing really did continue from the cover, and the inclusions from the
    // page the pricing ended on — those bands stay marked as continuations.
    expect(bandOnPage(pdfBytes, 2)).toBe('Pricing (cont.)');
    expect(bandOnPage(pdfBytes, sections.inclusions + 1)).toBe('Inclusions & Exclusions (cont.)');
  });

  it('inclusions/exclusions sit between the pricing and the notes', async () => {
    const p = base({ lines: [line({})], inclusions: ['Stucco', 'Lath'], exclusions: ['Paint'], coverNotes: 'Hello.' });
    const { sections } = await generateProposalPdf(input(p));
    expect(sections.inclusions).toBe(1);
    expect(sections.notes).toBe(1);
    expect(sections.inclusions).toBeLessThanOrEqual(sections.notes);
  });

  it('photos render 2-up with captions; terms add a page', async () => {
    const p = base({ lines: [line({})], terms: 'Pay on time.' });
    const { pdfBytes, sections } = await generateProposalPdf(input(p, {
      photos: [{ dataUrl: JPEG, caption: 'North' }, { dataUrl: JPEG, caption: null }, { dataUrl: JPEG, caption: 'x' }],
    }));
    expect(await pages(pdfBytes)).toBe(3); // cover/pricing, terms, photos
    expect(sections.terms).toBe(2);
    expect(sections.photos).toBe(3);
  });

  it('a signature-only proposal still gets the terms page', async () => {
    const p = base({ lines: [line({})], terms: '', includeSignature: true });
    const { pdfBytes, sections } = await generateProposalPdf(input(p));
    expect(await pages(pdfBytes)).toBe(2);
    expect(sections.terms).toBe(2);
  });

  it('cost detail is its own page and only covers takeoff lines', async () => {
    const takeoff = {
      id: 't1', name: 'Stucco', color: '#000', type: 'area', unit: 'sq ft',
      costPerUnit: 4, totalRealValue: 100, pageBreakdown: [],
    } as unknown as ProposalRenderInput['takeoffTotals'][number];
    const p = base({
      includeCostDetail: true,
      lines: [line({ id: 'a', kind: 'takeoff', takeoffId: 't1', description: 'Stucco', measurementSummary: '100.00 sq ft' })],
    });
    const withDetail = await generateProposalPdf(input(p, { takeoffTotals: [takeoff] }));
    expect(withDetail.sections.costDetail).toBe(2);

    // Manual-only proposals have nothing to detail — no page.
    const manualOnly = await generateProposalPdf(input(base({ includeCostDetail: true, lines: [line({})] })));
    expect(manualOnly.sections.costDetail).toBeUndefined();
  });

  it('a payment schedule prints under the grand total, percent rows resolved against it', async () => {
    const p = base({
      lines: [line({ amountCents: 100000 })],
      paymentSchedule: [
        { description: 'Deposit', percent: 50, amountCents: null },
        { description: 'On completion', percent: null, amountCents: 50000 },
      ],
    });
    const { pdfBytes, sections } = await generateProposalPdf(input(p));
    expect(await pages(pdfBytes)).toBe(1);
    expect(sections.paymentSchedule).toBe(1);
  });
  it('renders every section, in spec order, on non-decreasing pages', async () => {
    const takeoff = {
      id: 't1', name: 'Stucco', color: '#000', type: 'area', unit: 'sq ft',
      costPerUnit: 4, totalRealValue: 100, pageBreakdown: [],
    } as unknown as ProposalRenderInput['takeoffTotals'][number];
    const p = base({
      title: 'Full Job', validUntil: '2026-12-31', includeCostDetail: true, includeSignature: true,
      inclusions: ['Stucco', 'Lath'], exclusions: ['Paint', 'Permits'],
      coverNotes: 'Some context for the client.', terms: 'Net 30.',
      paymentSchedule: [{ description: 'Deposit', percent: 50, amountCents: null }],
      lines: [
        line({ id: 'a', kind: 'takeoff', takeoffId: 't1', description: 'Stucco', measurementSummary: '100.00 sq ft', amountCents: 40000 }),
        line({ id: 'b', description: 'Mobilization', amountCents: 25000 }),
        line({ id: 'c', kind: 'takeoff', takeoffId: 't1', description: 'Extra coat', isAlternate: true, amountCents: 5000 }),
        line({ id: 'd', description: 'Optional railing', isAlternate: true, amountCents: 1500 }),
      ],
    });
    const { sections } = await generateProposalPdf(input(p, {
      takeoffTotals: [takeoff],
      photos: [{ dataUrl: JPEG, caption: 'West wall' }],
      attachments: [await makePdf(1)],
    }));

    const order = ['grandTotal', 'paymentSchedule', 'inclusions', 'notes', 'alternates', 'costDetail', 'terms', 'photos', 'attachmentsStart'];
    const starts = order.map(k => sections[k]);
    expect(starts.filter(v => typeof v !== 'number')).toEqual([]); // every section rendered
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);     // and never out of order
  });
});
