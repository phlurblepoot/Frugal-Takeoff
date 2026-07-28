// src/pages/project/ProjectRfis.test.tsx
import { describe, it, expect } from 'vitest';
import { rfiNo, isRfiOverdue } from './ProjectRfis';

describe('rfiNo', () => {
  it('pads to three digits', () => {
    expect(rfiNo(1)).toBe('RFI-001');
    expect(rfiNo(42)).toBe('RFI-042');
    expect(rfiNo(1234)).toBe('RFI-1234');
  });
});

describe('isRfiOverdue', () => {
  const now = new Date('2026-07-28T12:00:00');
  it('true when past due and not answered/closed', () => {
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'sent' }, now)).toBe(true);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'open' }, now)).toBe(true);
  });
  it('false when answered, closed, not due yet, or dateless', () => {
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'answered' }, now)).toBe(false);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'closed' }, now)).toBe(false);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-29', status: 'sent' }, now)).toBe(false);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-28', status: 'sent' }, now)).toBe(false); // due today ≠ overdue
    expect(isRfiOverdue({ responseNeededBy: null, status: 'sent' }, now)).toBe(false);
  });
});
