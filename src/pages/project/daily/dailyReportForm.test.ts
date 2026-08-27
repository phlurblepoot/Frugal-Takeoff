import { describe, it, expect } from 'vitest';
import { normalizeManCounts, manCountLabel, weatherLine } from './dailyReportForm';

describe('normalizeManCounts', () => {
  it('drops empty-type lines and clamps counts to non-negative integers', () => {
    expect(normalizeManCounts([
      { type: ' Plasterer ', count: 4.7 }, { type: '', count: 3 }, { type: 'Sup', count: -1 },
    ])).toEqual([{ type: 'Plasterer', count: 4 }, { type: 'Sup', count: 0 }]);
  });
  it('keeps zero-count typed lines (a named crew with 0 men is meaningful)', () => {
    expect(normalizeManCounts([{ type: 'Laborer', count: 0 }])).toEqual([{ type: 'Laborer', count: 0 }]);
  });
});
describe('manCountLabel', () => {
  it('pluralizes', () => {
    expect(manCountLabel({ type: 'Plasterer', count: 4 })).toBe('Plasterer — 4 men');
    expect(manCountLabel({ type: 'Supervisor', count: 1 })).toBe('Supervisor — 1 man');
  });
});
describe('weatherLine', () => {
  it('joins summary and temperature, omitting empties', () => {
    expect(weatherLine('Partly cloudy', '58–74°F')).toBe('Partly cloudy · 58–74°F');
    expect(weatherLine('', '58–74°F')).toBe('58–74°F');
    expect(weatherLine('', '')).toBe('');
  });
});
