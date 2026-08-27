import { describe, it, expect } from 'vitest';
import { dailyReportHeading, dailyReportFileName } from './dailyReportPdf';

describe('dailyReportHeading', () => {
  it('joins title and date', () => {
    expect(dailyReportHeading({ reportDate: '2026-08-26', jobName: 'Dania Beach' })).toBe('Daily Report — Aug 26, 2026 · Dania Beach');
  });
  it('omits a blank job name', () => {
    expect(dailyReportHeading({ reportDate: '2026-08-26', jobName: '' })).toBe('Daily Report — Aug 26, 2026');
  });
});
describe('dailyReportFileName', () => {
  it('names by date', () => { expect(dailyReportFileName({ reportDate: '2026-08-26' })).toBe('DailyReport-2026-08-26.pdf'); });
});
