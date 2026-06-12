import { describe, it, expect } from 'vitest';
import { invoiceRows, invoiceTotalsBlock } from './invoicePdf';

describe('invoice pdf data shaping', () => {
  it('invoiceRows maps lines to [desc, qty, unit, amount] display strings', () => {
    const rows = invoiceRows([{ description: 'Drywall', qty: 2, unitPrice: 50 } as any]);
    expect(rows[0]).toEqual(['Drywall', '2', '$50.00', '$100.00']);
  });
  it('invoiceTotalsBlock formats total/paid/balance from cents', () => {
    expect(invoiceTotalsBlock(12550, 5000)).toEqual([
      ['Total', '$125.50'], ['Paid', '$50.00'], ['Balance Due', '$75.50'],
    ]);
  });
});
