import { describe, it, expect } from 'vitest';
import {
  EMAIL_TARGET_BYTES,
  usableBudget,
  pageBudget,
  attemptSequence,
  dataUrlBytes,
  JPEG_QUALITY_LADDER,
  START_LONG_SIDE,
  MIN_LONG_SIDE,
} from './shrinkPdf';

describe('email target', () => {
  it('is 18MB', () => {
    expect(EMAIL_TARGET_BYTES).toBe(18 * 1024 * 1024);
  });
});

describe('usableBudget', () => {
  it('reserves 3% + fixed overhead for PDF structure', () => {
    const b = usableBudget(18 * 1024 * 1024);
    expect(b).toBeLessThan(18 * 1024 * 1024 * 0.97);
    expect(b).toBeGreaterThan(17 * 1024 * 1024 * 0.97 - 128 * 1024);
  });
  it('never goes negative on tiny budgets', () => {
    expect(usableBudget(1000)).toBe(0);
  });
});

describe('pageBudget (running-remainder rollover)', () => {
  it('splits the remaining budget across the remaining pages', () => {
    expect(pageBudget(1000, 4)).toBe(250);
  });
  it('rolls surplus from cheap pages into later pages', () => {
    // 1000 across 4 pages → 250 each; first page only used 100,
    // so the remaining 900 across 3 pages → 300 each.
    expect(pageBudget(1000 - 100, 3)).toBe(300);
  });
  it('clamps to 0 when earlier pages overshot the whole budget', () => {
    expect(pageBudget(-500, 2)).toBe(0);
  });
});

describe('attemptSequence', () => {
  it('walks the full quality ladder at each scale before shrinking the scale', () => {
    const steps = attemptSequence();
    expect(steps.slice(0, JPEG_QUALITY_LADDER.length).map(s => s.quality))
      .toEqual([...JPEG_QUALITY_LADDER]);
    expect(new Set(steps.slice(0, JPEG_QUALITY_LADDER.length).map(s => s.longSide)).size).toBe(1);
    expect(steps[0].longSide).toBe(START_LONG_SIDE);
  });
  it('shrinks the long side by 0.8× per round and terminates at the floor', () => {
    const steps = attemptSequence();
    const scales = [...new Set(steps.map(s => s.longSide))];
    expect(scales[1]).toBe(Math.round(START_LONG_SIDE * 0.8));
    expect(scales[scales.length - 1]).toBe(MIN_LONG_SIDE);
    // Finite: floors terminate the walk.
    expect(steps.length).toBeLessThan(50);
  });
  it('never emits a long side below the floor', () => {
    for (const s of attemptSequence()) expect(s.longSide).toBeGreaterThanOrEqual(MIN_LONG_SIDE);
  });
});

describe('dataUrlBytes', () => {
  it('reports the decoded byte size of a base64 data URL', () => {
    // "hello" → 5 bytes → base64 "aGVsbG8="
    expect(dataUrlBytes('data:image/jpeg;base64,aGVsbG8=')).toBe(5);
  });
});
