import { describe, it, expect } from 'vitest';
import { takeoffPrintName, takeoffPrintsUrl } from './takeoffPrintNames';

describe('takeoff print names', () => {
  it('names by kind + project + ISO date', () => {
    const d = new Date('2026-08-28T15:00:00Z');
    expect(takeoffPrintName('Dania Beach', 'pdf', d)).toBe('Takeoff Print – Dania Beach – 2026-08-28');
    expect(takeoffPrintName('Dania Beach', 'excel', d)).toBe('Takeoff Export – Dania Beach – 2026-08-28');
  });

  it('builds the filtered documents url', () => {
    expect(takeoffPrintsUrl('p1')).toBe('/documents?projectIds=p1&kinds=takeoff-print,takeoff-export');
  });
});
