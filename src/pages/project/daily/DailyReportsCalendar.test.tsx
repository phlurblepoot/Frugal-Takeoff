// src/pages/project/daily/DailyReportsCalendar.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { DailyReportsCalendar, monthGrid } from './DailyReportsCalendar';
import { DailyReportListItem } from '../../../utils/store';

const report = (over: Partial<DailyReportListItem> = {}): DailyReportListItem => ({
  id: 'r1', projectId: 'p1', reportDate: '2026-09-05', jobName: 'Job', contractorName: 'GC',
  weatherSummary: '', temperature: '', manCounts: [], createdBy: null,
  createdAt: 1, updatedAt: 1, version: 1, photoCount: 0,
  ...over,
});

describe('monthGrid', () => {
  it('starts on Monday and covers whole weeks (length is a multiple of 7)', () => {
    const g = monthGrid(2026, 8); // September 2026 (0-based month)
    expect(g.length % 7).toBe(0);
  });

  it('September 2026 grid starts 2026-08-31 and covers through 2026-09-30', () => {
    const g = monthGrid(2026, 8);
    expect(g[0]).toEqual({ dateStr: '2026-08-31', inMonth: false });
    const inMonthDates = g.filter(c => c.inMonth).map(c => c.dateStr);
    expect(inMonthDates[0]).toBe('2026-09-01');
    expect(inMonthDates[inMonthDates.length - 1]).toBe('2026-09-30');
  });
});

describe('DailyReportsCalendar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 5)); // Sept 5, 2026 local
  });
  afterEach(() => { vi.useRealTimers(); });

  it('renders a glow-accent badge on a day with a report', () => {
    render(<DailyReportsCalendar reports={[report({ reportDate: '2026-09-10' })]} onOpen={vi.fn()} onCreate={vi.fn()} />);
    const cell = screen.getByTestId('daily-calendar-day-2026-09-10');
    expect(cell.querySelector('.glow-accent')).toBeTruthy();
  });

  it('calls onOpen with the report id when a report day is clicked', () => {
    const onOpen = vi.fn();
    render(<DailyReportsCalendar reports={[report({ id: 'rep-42', reportDate: '2026-09-10' })]} onOpen={onOpen} onCreate={vi.fn()} />);
    fireEvent.click(screen.getByTestId('daily-calendar-day-2026-09-10'));
    expect(onOpen).toHaveBeenCalledWith('rep-42');
  });

  it('calls onCreate with the dateStr when an empty day is clicked', () => {
    const onCreate = vi.fn();
    render(<DailyReportsCalendar reports={[]} onOpen={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(screen.getByTestId('daily-calendar-day-2026-09-15'));
    expect(onCreate).toHaveBeenCalledWith('2026-09-15');
  });

  it('navigates months with prev/next and Today returns to the current month', () => {
    render(<DailyReportsCalendar reports={[]} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByText('September 2026')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Next month'));
    expect(screen.getByText('October 2026')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Previous month'));
    fireEvent.click(screen.getByLabelText('Previous month'));
    expect(screen.getByText('August 2026')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Today'));
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });
});
