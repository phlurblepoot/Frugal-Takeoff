// src/pages/documents/docTypes.test.ts
import { describe, it, expect } from 'vitest';
import { kindLabel, kindTone, KIND_OPTIONS } from './docTypes';

describe('kindLabel', () => {
  it('resolves canonical kinds to their display label', () => {
    expect(kindLabel('invoice')).toBe('Invoice');
    expect(kindLabel('issue-report')).toBe('Issue');
    expect(kindLabel('punch-photo')).toBe('Punch Photo');
  });

  it('falls back to the raw kind string for anything unrecognized', () => {
    expect(kindLabel('plan')).toBe('plan');
  });

  it('resolves a custom:<id> kind against the supplied custom types list', () => {
    expect(kindLabel('custom:warranty', [{ id: 'warranty', label: 'Warranty' }])).toBe('Warranty');
  });

  it('falls back to the raw kind string when the custom type is unknown', () => {
    expect(kindLabel('custom:missing', [{ id: 'warranty', label: 'Warranty' }])).toBe('custom:missing');
  });
});

describe('kindTone', () => {
  it('gives billing-priced kinds an emerald tone', () => {
    expect(kindTone('invoice')).toBe('emerald');
    expect(kindTone('payapp-export')).toBe('emerald');
  });

  it('gives every custom kind the same tone regardless of id', () => {
    expect(kindTone('custom:anything')).toBe('violet');
  });

  it('falls back to slate for an unrecognized kind', () => {
    expect(kindTone('plan')).toBe('slate');
  });
});

describe('KIND_OPTIONS', () => {
  it('never includes the always-hidden plan/settings-asset kinds', () => {
    const ids = KIND_OPTIONS.map(o => o.id);
    expect(ids).not.toContain('plan');
    expect(ids).not.toContain('settings-asset');
  });

  it('has a unique id per option', () => {
    const ids = KIND_OPTIONS.map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
