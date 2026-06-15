// src/pages/Dashboard.test.tsx
import { describe, it, expect } from 'vitest';
import { hoursThisWeek, startOfWeek, timeAgo } from './Dashboard';

describe('startOfWeek', () => {
  it('returns the preceding Monday at 00:00', () => {
    // Wed 2026-06-10 15:30 local → Mon 2026-06-08 00:00 local
    const wed = new Date(2026, 5, 10, 15, 30);
    const start = new Date(startOfWeek(wed));
    expect(start.getDay()).toBe(1); // Monday
    expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
    expect(start.getDate()).toBe(8);
  });
});

describe('hoursThisWeek', () => {
  it('sums only entries clocked in this week, counting open entries to now', () => {
    const now = new Date(2026, 5, 10, 12, 0).getTime(); // Wed noon
    const monday = startOfWeek(new Date(now));
    const entries = [
      { id: '1', projectId: null, clockIn: monday + 3_600_000, clockOut: monday + 3 * 3_600_000, description: '' }, // 2h
      { id: '2', projectId: null, clockIn: now - 1_800_000, clockOut: null, description: '' },                      // 0.5h open
      { id: '3', projectId: null, clockIn: monday - 24 * 3_600_000, clockOut: monday - 20 * 3_600_000, description: '' }, // last week
    ];
    expect(hoursThisWeek(entries, now)).toBeCloseTo(2.5, 5);
  });
});

describe('timeAgo', () => {
  it('formats rough relative times', () => {
    const now = Date.now();
    expect(timeAgo(now - 30_000)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86_400_000)).toBe('2d ago');
  });
});
