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
  it('names by date alone when no project/job name is given', () => {
    expect(dailyReportFileName({ reportDate: '2026-08-26' })).toBe('DailyReport-2026-08-26.pdf');
  });
  it('names by date alone when the name is blank', () => {
    expect(dailyReportFileName({ reportDate: '2026-08-26' }, '')).toBe('DailyReport-2026-08-26.pdf');
  });
  it('includes a sanitized project/job name', () => {
    expect(dailyReportFileName({ reportDate: '2026-08-26' }, 'Dania Beach')).toBe('DailyReport-Dania-Beach-2026-08-26.pdf');
  });
  it('strips characters illegal in filenames', () => {
    expect(dailyReportFileName({ reportDate: '2026-08-26' }, 'Big/Bear: "Plaster" <Co>')).toBe('DailyReport-BigBear-Plaster-Co-2026-08-26.pdf');
  });
});
