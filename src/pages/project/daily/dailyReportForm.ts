import type { ManCountLine } from '../../../utils/store';

export const normalizeManCounts = (lines: ManCountLine[]): ManCountLine[] =>
  lines
    .map(l => ({ type: l.type.trim(), count: Number.isFinite(l.count) ? Math.max(0, Math.floor(l.count)) : 0 }))
    .filter(l => l.type !== '');
export const manCountLabel = (l: ManCountLine): string => `${l.type} — ${l.count} ${l.count === 1 ? 'man' : 'men'}`;
export const weatherLine = (summary: string, temperature: string): string =>
  [summary, temperature].filter(Boolean).join(' · ');
