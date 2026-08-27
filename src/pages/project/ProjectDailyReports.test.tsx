import { describe, it, expect } from 'vitest';
import { manCountTotal, formatReportDate } from './ProjectDailyReports';

describe('manCountTotal', () => {
  it('sums counts', () => { expect(manCountTotal([{ type: 'Plasterer', count: 4 }, { type: 'Supervisor', count: 1 }])).toBe(5); });
  it('ignores non-finite/negative counts and empty lists', () => {
    expect(manCountTotal([])).toBe(0);
    expect(manCountTotal([{ type: 'x', count: NaN as any }, { type: 'y', count: -2 }, { type: 'z', count: 3 }])).toBe(3);
  });
});
describe('formatReportDate', () => {
  it('renders YYYY-MM-DD as a readable local date without timezone drift', () => {
    expect(formatReportDate('2026-08-26')).toBe('Aug 26, 2026');   // must NOT show Aug 25 in negative-offset timezones
  });
  it('falls back to the raw string when malformed', () => { expect(formatReportDate('garbage')).toBe('garbage'); });
});
