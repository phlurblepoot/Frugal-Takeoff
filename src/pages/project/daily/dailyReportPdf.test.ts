import { describe, it, expect } from 'vitest';
import { dailyReportHeading, dailyReportFileName, dailyReportFieldRows } from './dailyReportPdf';

describe('dailyReportHeading', () => {
  it('joins title and date', () => {
    expect(dailyReportHeading({ reportDate: '2026-08-26', jobName: 'Dania Beach' })).toBe('Daily Report — Aug 26, 2026 · Dania Beach');
  });
  it('omits a blank job name', () => {
    expect(dailyReportHeading({ reportDate: '2026-08-26', jobName: '' })).toBe('Daily Report — Aug 26, 2026');
  });
  it('names the crew before the job', () => {
    expect(dailyReportHeading({ reportDate: '2026-08-26', jobName: 'Dania Beach', crewName: 'Smith Drywall' }))
      .toBe('Daily Report — Aug 26, 2026 · Smith Drywall · Dania Beach');
    expect(dailyReportHeading({ reportDate: '2026-08-26', jobName: '', crewName: 'Crew 1' })).toBe('Daily Report — Aug 26, 2026 · Crew 1');
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
  // One date can hold a report per crew: DailyReport-<project>-<crew>-<date>.
  it('includes the sanitized crew name between the project and the date', () => {
    expect(dailyReportFileName({ reportDate: '2026-08-26', crewName: 'Crew 1' }, 'Dania Beach')).toBe('DailyReport-Dania-Beach-Crew-1-2026-08-26.pdf');
    expect(dailyReportFileName({ reportDate: '2026-08-26', crewName: 'Smith / Sons: "Nights"' }, 'Dania')).toBe('DailyReport-Dania-Smith-Sons-Nights-2026-08-26.pdf');
  });
  it('keeps the crew when the project name is blank, and drops a missing crew', () => {
    expect(dailyReportFileName({ reportDate: '2026-08-26', crewName: 'Crew 1' }, '')).toBe('DailyReport-Crew-1-2026-08-26.pdf');
    expect(dailyReportFileName({ reportDate: '2026-08-26', crewName: null }, 'Dania')).toBe('DailyReport-Dania-2026-08-26.pdf');
  });
});
describe('dailyReportFieldRows', () => {
  const base = { jobName: 'Dania Beach', contractorName: 'GC Inc', reportDate: '2026-08-26' };
  it('prints the start time under the date', () => {
    expect(dailyReportFieldRows({ ...base, startTime: '07:00' })).toEqual([
      ['Job name:', 'Dania Beach'], ['Contractor:', 'GC Inc'], ['Date:', 'Aug 26, 2026'], ['Start time:', '7:00 AM'],
    ]);
  });
  it('prints the crew after the contractor', () => {
    expect(dailyReportFieldRows({ ...base, crewName: 'Smith Drywall', startTime: '07:00' })).toEqual([
      ['Job name:', 'Dania Beach'], ['Contractor:', 'GC Inc'], ['Crew:', 'Smith Drywall'], ['Date:', 'Aug 26, 2026'], ['Start time:', '7:00 AM'],
    ]);
  });
  it('leaves the row out for a report without a start time, as it printed before', () => {
    expect(dailyReportFieldRows({ ...base, startTime: null })).toEqual([
      ['Job name:', 'Dania Beach'], ['Contractor:', 'GC Inc'], ['Date:', 'Aug 26, 2026'],
    ]);
  });
});
