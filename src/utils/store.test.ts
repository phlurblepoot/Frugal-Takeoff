import { describe, it, expect } from 'vitest';
import { resolveRetainageMode, AiaSovLine } from './store';

const line = (retainagePercent: number | null): Pick<AiaSovLine, 'retainagePercent'> => ({ retainagePercent });

describe('resolveRetainageMode', () => {
  it('returns the explicit mode when set, regardless of SOV data', () => {
    expect(resolveRetainageMode('uniform', [line(12)])).toBe('uniform');
    expect(resolveRetainageMode('perLine', [])).toBe('perLine');
  });

  it('infers perLine when the mode is absent but a line carries a per-line rate', () => {
    expect(resolveRetainageMode(undefined, [line(null), line(8)])).toBe('perLine');
  });

  it('infers uniform when the mode is absent and no line carries a per-line rate', () => {
    expect(resolveRetainageMode(undefined, [line(null), line(null)])).toBe('uniform');
  });

  it('infers uniform when the mode is absent and there are no SOV lines at all', () => {
    expect(resolveRetainageMode(undefined, [])).toBe('uniform');
  });
});
