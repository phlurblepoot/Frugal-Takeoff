import { describe, it, expect } from 'vitest';
import { buildReadPrompt, parseReadResponse, buildMatchPrompt, parseMatchResponse } from './prompt';

describe('buildReadPrompt', () => {
  it('asks for strict JSON and mentions sheet number + title', () => {
    const p = buildReadPrompt();
    expect(p).toMatch(/JSON/i);
    expect(p).toMatch(/sheetNumber/);
    expect(p).toMatch(/sheetTitle/);
  });
  it('includes the embedded text hint when provided', () => {
    const p = buildReadPrompt('A-201 SECOND FLOOR PLAN');
    expect(p).toContain('A-201 SECOND FLOOR PLAN');
  });
  it('omits the hint section when there is no embedded text', () => {
    expect(buildReadPrompt('')).not.toMatch(/reference/i);
  });
});

describe('parseReadResponse', () => {
  it('parses clean JSON and upper-cases/trims the number', () => {
    const r = parseReadResponse('{"sheetNumber":" a-201 ","sheetTitle":"Second Floor Plan","discipline":"Architectural","confidence":0.9}');
    expect(r).toEqual({ sheetNumber: 'A-201', sheetTitle: 'Second Floor Plan', discipline: 'Architectural', confidence: 0.9 });
  });
  it('extracts JSON embedded in prose', () => {
    const r = parseReadResponse('Sure! Here you go:\n{"sheetNumber":"S1.1","sheetTitle":"Foundation Plan","confidence":0.8}\nHope that helps.');
    expect(r.sheetNumber).toBe('S1.1');
    expect(r.sheetTitle).toBe('Foundation Plan');
  });
  it('clamps confidence to 0..1', () => {
    expect(parseReadResponse('{"sheetNumber":"A1","sheetTitle":"x","confidence":5}').confidence).toBe(1);
    expect(parseReadResponse('{"sheetNumber":"A1","sheetTitle":"x","confidence":-3}').confidence).toBe(0);
  });
  it('returns a low-confidence empty read on unparseable output', () => {
    expect(parseReadResponse('the model said nothing useful')).toEqual({ sheetNumber: '', sheetTitle: '', confidence: 0 });
  });
});

describe('buildMatchPrompt', () => {
  it('lists existing sheets by id/number/title and the new page', () => {
    const p = buildMatchPrompt(
      { sheetNumber: 'A-201', sheetTitle: 'Second Floor Plan', confidence: 0.9 },
      [{ sheetId: 's1', number: 'A-101', title: 'First Floor Plan' }, { sheetId: 's2', number: 'A-201', title: 'Second Floor' }],
    );
    expect(p).toContain('s1');
    expect(p).toContain('A-101');
    expect(p).toContain('Second Floor Plan');
    expect(p).toMatch(/"new"/);
  });
});

describe('parseMatchResponse', () => {
  const ids = ['s1', 's2'];
  it('accepts a valid id', () => {
    expect(parseMatchResponse('{"matchSheetId":"s2","confidence":0.95}', ids)).toEqual({ matchSheetId: 's2', confidence: 0.95, reason: undefined });
  });
  it('maps "new" / unknown ids to null', () => {
    expect(parseMatchResponse('{"matchSheetId":"new","confidence":0.7}', ids).matchSheetId).toBeNull();
    expect(parseMatchResponse('{"matchSheetId":"HALLUCINATED","confidence":0.7}', ids).matchSheetId).toBeNull();
  });
  it('keeps a short reason and clamps confidence', () => {
    const r = parseMatchResponse('{"matchSheetId":"s1","confidence":2,"reason":"same number"}', ids);
    expect(r).toEqual({ matchSheetId: 's1', confidence: 1, reason: 'same number' });
  });
  it('returns null match on unparseable output', () => {
    expect(parseMatchResponse('nonsense', ids)).toEqual({ matchSheetId: null, confidence: 0, reason: undefined });
  });
});
