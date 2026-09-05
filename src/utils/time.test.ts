// src/utils/time.test.ts
import { describe, it, expect } from 'vitest';
import { DAY, timeAgo, startOfWeek, hoursThisWeek, fmtDate } from './time';

describe('DAY', () => {
  it('is 86,400,000ms', () => {
    expect(DAY).toBe(86_400_000);
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

describe('startOfWeek', () => {
  it('returns the preceding Monday at 00:00 for a mid-week date', () => {
    // Wed 2026-06-10 15:30 local → Mon 2026-06-08 00:00 local
    const wed = new Date(2026, 5, 10, 15, 30);
    const start = new Date(startOfWeek(wed));
    expect(start.getDay()).toBe(1); // Monday
    expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
    expect(start.getDate()).toBe(8);
  });

  it('anchors a Sunday input to the Monday that started that same week (not the next Monday)', () => {
    // Sun 2026-06-14 → Mon 2026-06-08 00:00 local (Monday-anchored ISO week
    // containing the Sunday, not the following week's Monday).
    const sun = new Date(2026, 5, 14, 9, 0);
    const start = new Date(startOfWeek(sun));
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(8);
    expect(start.getMonth()).toBe(5);
  });
});

describe('hoursThisWeek', () => {
  it('sums only entries clocked in this week, counting open entries to now', () => {
    const now = new Date(2026, 5, 10, 12, 0).getTime(); // Wed noon
    const monday = startOfWeek(new Date(now));
    const entries = [
      { clockIn: monday + 3_600_000, clockOut: monday + 3 * 3_600_000 }, // 2h
      { clockIn: now - 1_800_000, clockOut: null },                      // 0.5h open
      { clockIn: monday - 24 * 3_600_000, clockOut: monday - 20 * 3_600_000 }, // last week
    ];
    expect(hoursThisWeek(entries, now)).toBeCloseTo(2.5, 5);
  });

  it('charges an overnight Sun→Mon shift to the week it started in (last week)', () => {
    // Monday 2026-06-08 00:00 is the start of "this" week.
    const now = new Date(2026, 5, 10, 12, 0).getTime(); // Wed noon, same week
    const monday = startOfWeek(new Date(now));
    const sundayBeforeMidnight = monday - 2 * 3_600_000; // Sun 22:00, previous week
    const mondayAfterMidnight = monday + 1 * 3_600_000;  // Mon 01:00, this week
    const entries = [
      { clockIn: sundayBeforeMidnight, clockOut: mondayAfterMidnight }, // started last week
    ];
    // Charged entirely to the week it STARTED in → excluded from "this week".
    expect(hoursThisWeek(entries, now)).toBe(0);
  });
});

describe('fmtDate', () => {
  it('formats an epoch-ms number', () => {
    const ms = new Date(2026, 5, 10).getTime();
    expect(fmtDate(ms)).toBe(new Date(ms).toLocaleDateString());
  });

  it('formats an ISO string', () => {
    const iso = '2026-06-10T00:00:00.000Z';
    expect(fmtDate(iso)).toBe(new Date(iso).toLocaleDateString());
  });

  it('returns an em dash for null or undefined', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
  });
});
