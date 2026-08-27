import type { ManCountLine } from '../../../utils/store';

export const normalizeManCounts = (lines: ManCountLine[]): ManCountLine[] =>
  lines
    .map(l => ({ type: l.type.trim(), count: Number.isFinite(l.count) ? Math.max(0, Math.floor(l.count)) : 0 }))
    .filter(l => l.type !== '');
export const manCountLabel = (l: ManCountLine): string => `${l.type} — ${l.count} ${l.count === 1 ? 'man' : 'men'}`;
export const weatherLine = (summary: string, temperature: string): string =>
  [summary, temperature].filter(Boolean).join(' · ');

export const manCountTotal = (lines: ManCountLine[]): number =>
  lines.reduce((s, l) => s + (Number.isFinite(l.count) && l.count > 0 ? l.count : 0), 0);

export const formatReportDate = (d: string): string => {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return d;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
