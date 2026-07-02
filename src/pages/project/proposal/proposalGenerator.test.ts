// src/pages/project/proposal/proposalGenerator.test.ts
// CHARACTERIZATION tests: lock in what the pure helpers in proposalGenerator.ts
// do TODAY.  Do not "fix" surprising behavior — assert the current output and
// comment where it differs from naive expectation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  hexToRgb,
  formatCurrency,
  dataUrlToUint8Array,
  HIGHLIGHT_QUALITY_PRESETS,
  getProposalPrefsKey,
  resolveGrandTotal,
  computeTakeoffTotals,
} from './proposalGenerator';
import type { ProposalOptions, TakeoffTotals } from './proposalGenerator';
import { computeRevisionModel } from '../../../utils/planSets';
import type { Project, ProjectPage } from '../../../types';

// ── hexToRgb ────────────────────────────────────────────────────────────────
// NOTE: hexToRgb returns 0-1 RGB components for pdf-lib's rgb(), NOT 0-255.
describe('hexToRgb', () => {
  it('#1e293b → correct fractional RGB', () => {
    // 0x1e=30, 0x29=41, 0x3b=59  →  /255 each
    const result = hexToRgb('#1e293b');
    expect(result.r).toBeCloseTo(30 / 255);
    expect(result.g).toBeCloseTo(41 / 255);
    expect(result.b).toBeCloseTo(59 / 255);
  });

  it('#ffffff → {r:1, g:1, b:1}', () => {
    const result = hexToRgb('#ffffff');
    expect(result.r).toBeCloseTo(1);
    expect(result.g).toBeCloseTo(1);
    expect(result.b).toBeCloseTo(1);
  });

  it('#000000 → {r:0, g:0, b:0}', () => {
    const result = hexToRgb('#000000');
    expect(result).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('malformed input "xyz" → default blue fallback', () => {
    // characterization: regex /^#?([0-9a-f]{6})$/i does not match "xyz"
    // (only 3 non-hex chars), so the function returns the hard-coded default
    // { r: 0.231, g: 0.510, b: 0.965 }
    const result = hexToRgb('xyz');
    expect(result).toEqual({ r: 0.231, g: 0.510, b: 0.965 });
  });

  it('short-form "#fff" → default blue fallback', () => {
    // characterization: "#fff" is only 3 hex chars after the hash, regex
    // requires exactly 6, so the fallback fires — same as malformed input
    const result = hexToRgb('#fff');
    expect(result).toEqual({ r: 0.231, g: 0.510, b: 0.965 });
  });
});

// ── formatCurrency ───────────────────────────────────────────────────────────
describe('formatCurrency', () => {
  it('1234.5 → "$1,234.50"', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('0 → "$0.00"', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('-5 → "$-5.00"', () => {
    // characterization: toLocaleString produces "-5.00", prepend "$" → "$-5.00"
    expect(formatCurrency(-5)).toBe('$-5.00');
  });
});

// ── dataUrlToUint8Array ──────────────────────────────────────────────────────
describe('dataUrlToUint8Array', () => {
  it('decodes base64 "QUJD" (= "ABC") → [65, 66, 67]', () => {
    const dataUrl = 'data:application/pdf;base64,QUJD';
    const result = dataUrlToUint8Array(dataUrl);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([65, 66, 67]);
  });
});

// ── HIGHLIGHT_QUALITY_PRESETS ────────────────────────────────────────────────
describe('HIGHLIGHT_QUALITY_PRESETS', () => {
  it('has keys: full, large, standard, compact', () => {
    const keys = Object.keys(HIGHLIGHT_QUALITY_PRESETS);
    expect(keys).toContain('full');
    expect(keys).toContain('large');
    expect(keys).toContain('standard');
    expect(keys).toContain('compact');
  });

  it.each(['full', 'large', 'standard', 'compact'] as const)(
    '%s preset has label (string), maxDim (number), jpegQuality (number)',
    (key) => {
      const preset = HIGHLIGHT_QUALITY_PRESETS[key];
      expect(typeof preset.label).toBe('string');
      expect(typeof preset.maxDim).toBe('number');
      expect(typeof preset.jpegQuality).toBe('number');
    }
  );

  it('full preset uses Infinity maxDim and 0.90 jpegQuality', () => {
    expect(HIGHLIGHT_QUALITY_PRESETS.full.maxDim).toBe(Infinity);
    expect(HIGHLIGHT_QUALITY_PRESETS.full.jpegQuality).toBe(0.90);
  });

  it('compact preset has the smallest maxDim', () => {
    const dims = (['full', 'large', 'standard', 'compact'] as const).map(
      k => HIGHLIGHT_QUALITY_PRESETS[k].maxDim
    );
    expect(HIGHLIGHT_QUALITY_PRESETS.compact.maxDim).toBe(Math.min(...dims));
  });
});

// ── getProposalPrefsKey ──────────────────────────────────────────────────────
describe('getProposalPrefsKey', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('no "user" item in localStorage → "proposal-prefs-default"', () => {
    expect(getProposalPrefsKey()).toBe('proposal-prefs-default');
  });

  it('user with id "u1" → "proposal-prefs-u1"', () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1' }));
    expect(getProposalPrefsKey()).toBe('proposal-prefs-u1');
  });

  it('user item with no id field → "proposal-prefs-default"', () => {
    // characterization: JSON.parse succeeds but user.id is undefined → "default"
    localStorage.setItem('user', JSON.stringify({ name: 'Alice' }));
    expect(getProposalPrefsKey()).toBe('proposal-prefs-default');
  });

  it('malformed JSON in "user" → "proposal-prefs-default"', () => {
    // characterization: JSON.parse throws → catch returns "proposal-prefs-default"
    localStorage.setItem('user', 'not-json{{{');
    expect(getProposalPrefsKey()).toBe('proposal-prefs-default');
  });
});

// ── resolveGrandTotal ─────────────────────────────────────────────────────────
describe('resolveGrandTotal', () => {
  // Minimal ProposalOptions — only priceMode / fixedPriceTotal matter here.
  const baseOptions = (over: Partial<ProposalOptions> = {}): ProposalOptions => ({
    includeCostDetail: false,
    includeHighlights: false,
    headerColor: '#000000',
    coverNotes: '',
    fontFamily: 'helvetica',
    validUntil: '',
    terms: '',
    includeSignature: false,
    includeTakeoffList: false,
    customTitle: '',
    highlightQuality: 'standard',
    ...over,
  });

  // Minimal TakeoffTotals stub: simple-cost path → costPerUnit * totalRealValue.
  const stub = (totalRealValue: number, costPerUnit: number): TakeoffTotals =>
    ({ totalRealValue, costPerUnit, pageBreakdown: [] } as unknown as TakeoffTotals);

  it('fixed mode returns fixedPriceTotal', () => {
    const result = resolveGrandTotal(baseOptions({ priceMode: 'fixed', fixedPriceTotal: 12345 }), [
      stub(100, 5), // would be 500 in takeoff mode — must be ignored
    ]);
    expect(result).toBe(12345);
  });

  it('fixed mode with undefined fixedPriceTotal returns 0', () => {
    const result = resolveGrandTotal(baseOptions({ priceMode: 'fixed' }), [stub(100, 5)]);
    expect(result).toBe(0);
  });

  it('takeoffs mode sums calculateTakeoffTotalCost across the list', () => {
    // 10*2=20 + 3*4=12 + 5*5=25  →  57
    const result = resolveGrandTotal(baseOptions({ priceMode: 'takeoffs' }), [
      stub(10, 2),
      stub(3, 4),
      stub(5, 5),
    ]);
    expect(result).toBe(57);
  });

  it('undefined priceMode defaults to takeoffs-mode summing', () => {
    const result = resolveGrandTotal(baseOptions(), [stub(10, 2), stub(3, 4)]);
    expect(result).toBe(32);
  });

  it('takeoffs mode over empty list returns 0', () => {
    expect(resolveGrandTotal(baseOptions({ priceMode: 'takeoffs' }), [])).toBe(0);
  });
});

// ── computeTakeoffTotals: revision (sheetId) de-duplication ───────────────────
// Guards against the old double-counting bug: a sheet with multiple revisions
// (older + newer page sharing one sheetId) must contribute ONLY the current
// (newest) revision's measurements to the takeoff totals — never the sum of both.
describe('computeTakeoffTotals only counts the current living revision', () => {
  // Same fixture style as planSets.test.ts.
  const mkPage = (o: Partial<ProjectPage>): ProjectPage => ({
    id: 'p', name: '', pageNumber: '', description: '', imageId: '', thumbnailId: '',
    imageWidth: 0, imageHeight: 0, measurements: [], scaleConfig: null, ...o,
  } as ProjectPage);

  const mkProj = (pages: ProjectPage[], planSets: any[], takeoffs: any[]): Project => ({
    id: 'pr', name: 'x', createdAt: 0, pages, takeoffs, planSets,
  } as Project);

  it('two revisions of sheet A-101 sharing a sheetId count once (newest), not summed', () => {
    // 1:1 scale (100px = 100 ft) so a 100px polyline → 100 ft. Reused by both pages.
    const scaleConfig = { pixelDistance: 100, realWorldDistance: 100, unit: 'ft' } as any;
    // A real-enough length measurement on takeoff t1: two points 100px apart.
    const lengthMeasurement = (id: string) => ({
      id, type: 'length', name: id, color: '#000', takeoffId: 't1',
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    } as any);

    const sets = [
      { id: 's1', name: 'Set 1', createdAt: 1 },
      { id: 's2', name: 'Set 2', createdAt: 2 },
    ];
    // Older revision (planSet s1) carries a measurement on t1.
    const a1 = mkPage({
      id: 'a1', name: 'A-101 (rev 1)', sheetId: 'A', pageNumber: 'A-101',
      planSetId: 's1', scaleConfig, measurements: [lengthMeasurement('m-old')],
    });
    // Newer revision (planSet s2) — SAME sheetId — also carries a measurement on t1.
    const a2 = mkPage({
      id: 'a2', name: 'A-101 (rev 2)', sheetId: 'A', pageNumber: 'A-101',
      planSetId: 's2', scaleConfig, measurements: [lengthMeasurement('m-new')],
    });
    const takeoffs = [{ id: 't1', name: 'Wall', color: '#000', type: 'length', unit: 'ft' }];
    const project = mkProj([a1, a2], sets, takeoffs);

    // The consumer derives current pages exactly as the proposal section does.
    const currentPageIds = computeRevisionModel(project, '').currentPageIds;
    expect([...currentPageIds]).toEqual(['a2']); // sanity: only the newest revision is current

    const totals = computeTakeoffTotals(project, currentPageIds);
    const t1 = totals.find(t => t.id === 't1')!;

    // ROBUST CHECK: pageBreakdown references ONLY the current page id — never both.
    expect(t1.pageBreakdown.map(b => b.pageId)).toEqual(['a2']);
    expect(t1.pageBreakdown.map(b => b.pageId)).not.toContain('a1');

    // CORROBORATING CHECK: total equals a SINGLE revision's value (100 ft), not 200.
    const singleRevisionValue = t1.pageBreakdown[0].realValue;
    expect(t1.totalRealValue).toBeCloseTo(singleRevisionValue);
    expect(t1.totalRealValue).toBeCloseTo(100);
    // Explicitly not the double-counted sum of both revisions.
    expect(t1.totalRealValue).not.toBeCloseTo(200);
  });
});
