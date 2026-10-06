// src/pages/reports/reportDates.ts — the Payments received report's date
// range: presets over the local calendar, and how a report shows a calendar
// day. Report dates travel as 'YYYY-MM-DD' (server/reportsStore.ts dayOf), so
// they are shown as that day, never shifted through a timezone.

export type DatePreset = 'this-month' | 'last-month' | 'this-quarter' | 'year-to-date' | 'last-year' | 'all' | 'custom';

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'this-quarter', label: 'This quarter' },
  { value: 'year-to-date', label: 'Year to date' },
  { value: 'last-year', label: 'Last year' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

export const DEFAULT_DATE_PRESET: DatePreset = 'this-month';

/** A local Date as 'YYYY-MM-DD'. */
export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The days a preset covers, both inclusive ('' = open). 'custom' has none of its own. */
export function presetRange(preset: DatePreset, today: Date = new Date()): { from: string; to: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (preset) {
    case 'this-month': return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) };
    case 'last-month': return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
    case 'this-quarter': {
      const q = Math.floor(m / 3) * 3;
      return { from: ymd(new Date(y, q, 1)), to: ymd(new Date(y, q + 3, 0)) };
    }
    case 'year-to-date': return { from: ymd(new Date(y, 0, 1)), to: ymd(today) };
    case 'last-year': return { from: ymd(new Date(y - 1, 0, 1)), to: ymd(new Date(y - 1, 11, 31)) };
    case 'all':
    case 'custom': return { from: '', to: '' };
  }
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' as a local Date (midnight), or null. */
export function parseDay(day: string | null | undefined): Date | null {
  const m = day ? DAY_RE.exec(day) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** A report day in the viewer's date format; '—' when there is none. */
export const formatDay = (day: string | null | undefined): string => parseDay(day)?.toLocaleDateString() ?? '—';

/** "10/1/2026 – 10/31/2026", "From 10/1/2026", "Through 10/31/2026", "All dates". */
export function rangeLabel(from: string, to: string): string {
  if (from && to) return `${formatDay(from)} – ${formatDay(to)}`;
  if (from) return `From ${formatDay(from)}`;
  if (to) return `Through ${formatDay(to)}`;
  return 'All dates';
}
