import { describe, it, expect } from 'vitest';
import { roleForTemplate, resolveRecipient } from './recipients';

describe('roleForTemplate', () => {
  it('maps templates to roles', () => {
    expect(roleForTemplate('proposal')).toBe('estimating');
    expect(roleForTemplate('invoice')).toBe('accounting');
    expect(roleForTemplate('changeOrder')).toBe('accounting');
    expect(roleForTemplate('issue')).toBe('pm');
    expect(roleForTemplate('punch')).toBe('pm');
  });
});

describe('resolveRecipient', () => {
  const cust = { estimating: 'est@c.com', accounting: 'ap@c.com', general: 'info@c.com' };
  it('prefers the project override for the role', () => {
    expect(resolveRecipient('proposal', { estimating: 'proj@x.com' }, cust)).toBe('proj@x.com');
  });
  it('falls back to the customer role', () => {
    expect(resolveRecipient('proposal', {}, cust)).toBe('est@c.com');
  });
  it('falls back to project general, then customer general', () => {
    expect(resolveRecipient('issue', { general: 'pg@x.com' }, cust)).toBe('pg@x.com');
    expect(resolveRecipient('issue', undefined, cust)).toBe('info@c.com');
  });
  it('returns empty when nothing is set', () => {
    expect(resolveRecipient('invoice', undefined, undefined)).toBe('');
  });
});
