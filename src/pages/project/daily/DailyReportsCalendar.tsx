// src/pages/project/daily/DailyReportsCalendar.tsx
// Month calendar for a project's daily reports, styled after the Time
// Keeping page's calendar (bg-raised card, accent-filled day cells, explicit
// text colors) so it reads correctly in both light and dark mode: days with
// a report fill with the accent color and open that report; empty days start
// a new report dated to that cell. Weeks start Monday (app-wide rule — Time
// Keeping's own grid is a legacy Sunday-start; only its look is reused).
// All date math stays in local time — `toISOString` would drift a day near
// midnight in negative-offset timezones.
import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Image as ImageIcon } from 'lucide-react';
import { DailyReportListItem } from '../../../utils/store';
import { manCountTotal } from './dailyReportForm';

const toDateStr = (d: Date): string => d.toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

/**
 * Builds the day cells for a Monday-start month calendar. `month` is
 * 0-based (0 = January). The result always covers whole weeks (length is a
 * multiple of 7), including muted leading/trailing days from adjacent months.
 */
export const monthGrid = (year: number, month: number): { dateStr: string; inMonth: boolean }[] => {
  const first = new Date(year, month, 1);
  // getDay(): 0=Sun..6=Sat. Convert to a Monday-start offset (0=Mon..6=Sun).
  const leadingCount = (first.getDay() + 6) % 7;

  const lastOfMonth = new Date(year, month + 1, 0);
  const trailingCount = (7 - ((lastOfMonth.getDay() + 6) % 7) - 1 + 7) % 7;
  const totalDays = leadingCount + lastOfMonth.getDate() + trailingCount;

  const cells: { dateStr: string; inMonth: boolean }[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(year, month, 1 - leadingCount + i);
    cells.push({ dateStr: toDateStr(d), inMonth: d.getMonth() === month });
  }
  return cells;
};

const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // Monday-start
const MONTH_LABEL = (year: number, month: number) =>
  new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

export interface DailyReportsCalendarProps {
  reports: DailyReportListItem[];
  onOpen: (id: string) => void;
  onCreate: (dateStr: string) => void;
}

export const DailyReportsCalendar: React.FC<DailyReportsCalendarProps> = ({ reports, onOpen, onCreate }) => {
  const today = new Date();
  const todayStr = toDateStr(today);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  // Server enforces one report per date, so at most one match per dateStr —
  // just take the first if that were ever violated.
  const byDate = new Map<string, DailyReportListItem>();
  for (const r of reports) {
    if (!byDate.has(r.reportDate)) byDate.set(r.reportDate, r);
  }

  const goPrev = () => { const d = new Date(year, month - 1, 1); setYear(d.getFullYear()); setMonth(d.getMonth()); };
  const goNext = () => { const d = new Date(year, month + 1, 1); setYear(d.getFullYear()); setMonth(d.getMonth()); };
  const goToday = () => { setYear(today.getFullYear()); setMonth(today.getMonth()); };

  const cells = monthGrid(year, month);

  return (
    <div data-testid="daily-calendar" className="rounded-2xl border border-edge bg-raised p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{MONTH_LABEL(year, month)}</h2>
        <div className="flex items-center gap-1">
          <button type="button" onClick={goToday} className="rounded-md px-2 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-hover hover:text-ink">
            Today
          </button>
          <button type="button" onClick={goPrev} aria-label="Previous month" className="rounded-lg p-1.5 text-ink-soft transition-colors hover:bg-hover hover:text-ink">
            <ChevronLeft size={16} />
          </button>
          <button type="button" onClick={goNext} aria-label="Next month" className="rounded-lg p-1.5 text-ink-soft transition-colors hover:bg-hover hover:text-ink">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="mb-1 grid grid-cols-7 gap-1">
        {WEEKDAY_LABELS.map((w, i) => (
          <div key={i} className="py-1 text-center text-[10px] font-bold uppercase tracking-wider text-ink-faint">{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map(({ dateStr, inMonth }) => {
          const report = byDate.get(dateStr);
          const isToday = dateStr === todayStr;
          const day = Number(dateStr.slice(-2));
          const crew = report ? manCountTotal(report.manCounts) : 0;

          return (
            <button
              key={dateStr}
              type="button"
              data-testid={`daily-calendar-day-${dateStr}`}
              data-report={report ? 'true' : undefined}
              aria-label={report ? `Open daily report for ${dateStr}` : `Create daily report for ${dateStr}`}
              onClick={() => report ? onOpen(report.id) : onCreate(dateStr)}
              className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg border p-1 text-[11px] font-medium transition-all sm:min-h-20 ${
                report
                  ? 'bg-accent-500 text-white'
                  : inMonth
                  ? 'bg-raised text-ink'
                  : 'bg-sunken/50 text-ink opacity-50'
              } ${
                isToday
                  ? report ? 'border-white/70' : 'border-accent-400 dark:border-accent-500'
                  : 'border-transparent'
              } hover:border-accent-300 dark:hover:border-accent-700`}
            >
              <span className="text-sm leading-none">{day}</span>
              {report && (
                <span className="hidden flex-col items-center gap-0.5 text-[9px] leading-tight text-white/90 sm:flex">
                  {report.photoCount > 0 && (
                    <span className="inline-flex items-center gap-1"><ImageIcon size={10} />{report.photoCount}</span>
                  )}
                  {crew > 0 && <span>{crew} men</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
