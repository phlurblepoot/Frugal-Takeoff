import { describe, it, expect } from 'vitest';
import { createDisabledRunner } from './disabledRunner';

describe('createDisabledRunner', () => {
  it('is never available and reports device "none"', async () => {
    const r = createDisabledRunner('disabled by config');
    expect(await r.available()).toBe(false);
    expect(r.info()).toEqual({ model: 'disabled by config', device: 'none' });
  });
  it('rejects readSheet and matchSheet', async () => {
    const r = createDisabledRunner();
    await expect(r.readSheet({ image: Buffer.from('') })).rejects.toThrow(/unavailable/i);
    await expect(r.matchSheet({ page: { sheetNumber: '', sheetTitle: '', confidence: 0 }, existing: [] })).rejects.toThrow(/unavailable/i);
  });
});
