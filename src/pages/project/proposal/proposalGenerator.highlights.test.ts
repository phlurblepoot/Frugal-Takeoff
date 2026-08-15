// src/pages/project/proposal/proposalGenerator.highlights.test.ts
// Regression test for the "highlights offset diagonally" printout bug: pages
// whose MediaBox origin is not (0,0) (center-origin CAD exports, e.g. TEG
// Dania Beach REV.pdf with MediaBox [-1512 -1080.12 1512 1080.12]) must have
// the overlay translated into the real view box, not drawn as if the page
// started at (0,0).
import { describe, it, expect, vi } from 'vitest';
import type { Project } from '../../../types';

// buildHighlightsPdf fetches the source PDF through the store; stub it to
// serve an in-memory synthetic document instead of the network.
let sourcePdfDataUrl = '';
vi.mock('../../../utils/store', () => ({
  getFile: vi.fn(async () => sourcePdfDataUrl),
  getImage: vi.fn(async () => null),
}));

import { buildHighlightsPdf, HIGHLIGHT_QUALITY_PRESETS, normalizeHighlightQuality } from './proposalGenerator';

async function makeSourcePdf(mediaBox: [number, number, number, number]): Promise<string> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([mediaBox[2], mediaBox[3]]);
  page.setMediaBox(...mediaBox); // x, y, width, height
  const bytes = await doc.save({ useObjectStreams: false });
  return 'data:application/pdf;base64,' + Buffer.from(bytes).toString('base64');
}

function makeProject(): Project {
  return {
    id: 'p1',
    name: 'Test',
    pages: [{
      id: 'page1',
      name: 'A-1',
      imageWidth: 1200,  // view box rendered at 2.0× → 600 pt wide source
      imageHeight: 800,
      sourcePdfFileId: 'src-pdf',
      sourcePdfPageNum: 1,
      showLegend: false,
      measurements: [{
        id: 'm1',
        takeoffId: 't1',
        type: 'area',
        points: [
          { x: 100, y: 100 }, { x: 500, y: 100 },
          { x: 500, y: 400 }, { x: 100, y: 400 },
        ],
      }],
    }],
    takeoffs: [{ id: 't1', name: 'Stucco', color: '#3b82f6', type: 'area' }],
  } as unknown as Project;
}

// The saved PDF packs objects into object streams, so the overlay operators
// aren't visible in the raw bytes — decode every content stream instead.
async function buildContentStreams(mediaBox: [number, number, number, number]): Promise<string> {
  sourcePdfDataUrl = await makeSourcePdf(mediaBox);
  const out = await buildHighlightsPdf(makeProject(), new Set(['t1']));
  expect(out).not.toBeNull();
  const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import('pdf-lib');
  const doc = await PDFDocument.load(new Uint8Array(out!));
  expect(doc.getPageCount()).toBe(1);
  const chunks: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        chunks.push(Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1'));
      } catch { /* non-content stream (e.g. image data) — skip */ }
    }
  }
  return chunks.join('\n----\n');
}

describe('buildHighlightsPdf view-box placement', () => {
  it('offset-origin MediaBox: overlay is translated by the view origin', async () => {
    // MediaBox [-100 -50 500 350] (600×400, origin not at (0,0)) — the shape
    // of the real-world bug. The overlay must concat a translation to
    // (-100, -50); without it every highlight shifts up-right by the origin.
    const ops = await buildContentStreams([-100, -50, 600, 400]);
    expect(ops).toMatch(/1 0 0 1 -100 -50 cm/);
  });

  it('normal (0,0)-origin MediaBox: no origin translation is emitted (legacy behavior)', async () => {
    // drawSvgPath legitimately emits its own positive-offset cm operators;
    // only a negative-translation placement matrix would indicate a change
    // in behavior for ordinary pages.
    const ops = await buildContentStreams([0, 0, 600, 400]);
    expect(ops).not.toMatch(/1 0 0 1 -[\d.]+ -[\d.]+ cm/);
  });
});

describe('highlight quality presets', () => {
  it('offers exactly best + email', () => {
    expect(Object.keys(HIGHLIGHT_QUALITY_PRESETS)).toEqual(['best', 'email']);
  });

  it('normalizes legacy stored preset values to best', () => {
    for (const legacy of ['full', 'large', 'standard', 'compact', '', undefined, null, 42]) {
      expect(normalizeHighlightQuality(legacy)).toBe('best');
    }
  });

  it('keeps valid values', () => {
    expect(normalizeHighlightQuality('email')).toBe('email');
    expect(normalizeHighlightQuality('best')).toBe('best');
  });
});
