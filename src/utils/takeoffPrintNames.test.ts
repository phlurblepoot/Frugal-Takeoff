import { describe, it, expect } from 'vitest';
import { takeoffPrintName, takeoffPrintsUrl } from './takeoffPrintNames';

describe('takeoff print names', () => {
  it('names by kind + project + local date', () => {
    // Local noon: the same calendar day in every timezone, so this asserts the
    // format without depending on where the suite runs.
    const d = new Date(2026, 7, 28, 12, 0, 0);
    expect(takeoffPrintName('Dania Beach', 'pdf', d)).toBe('Takeoff Print – Dania Beach – 2026-08-28');
    expect(takeoffPrintName('Dania Beach', 'excel', d)).toBe('Takeoff Export – Dania Beach – 2026-08-28');
  });

  it('uses the LOCAL date, not the UTC one, late in the evening', () => {
    // 11pm local on the 28th is already the 29th in UTC anywhere west of
    // Greenwich; the print is still dated the 28th. (Zero-padding is covered
    // here too — a single-digit month and day.)
    const late = new Date(2026, 0, 5, 23, 30, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(takeoffPrintName('Job', 'pdf', late))
      .toBe(`Takeoff Print – Job – ${late.getFullYear()}-${pad(late.getMonth() + 1)}-${pad(late.getDate())}`);
    expect(takeoffPrintName('Job', 'pdf', late)).toBe('Takeoff Print – Job – 2026-01-05');
  });

  it('builds the filtered documents url', () => {
    expect(takeoffPrintsUrl('p1')).toBe('/documents?projectIds=p1&kinds=takeoff-print,takeoff-export');
  });
});
