import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PricingLinesCard } from './PricingLinesCard';
import { ConfirmProvider } from '../../../components/ConfirmDialog';

const t = (id: string, name: string) => ({ id, name, type: 'area', color: '#fff', unit: 'sqft', costPerUnit: 1, totalRealValue: 10000, pageBreakdown: [] } as any);
const takeoffLine = { id: 'l1', sortOrder: 0, kind: 'takeoff' as const, takeoffId: 't1', description: 'Stucco', amountCents: 1000000, derivedAmountCents: 1000000, measurementSummary: '10,000.00 sq ft', isAlternate: false };
const wrap = (ui: React.ReactElement) => render(<ConfirmProvider>{ui}</ConfirmProvider>);

describe('PricingLinesCard', () => {
  it('shows takeoff lines with measurement summary and derived amount', () => {
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={() => {}} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    expect(screen.getByText('10,000.00 sq ft')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10000.00')).toBeInTheDocument();
  });

  it('overriding a takeoff amount asks for confirmation, then marks the line overridden with a reset', async () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    const amt = screen.getByDisplayValue('10000.00');
    fireEvent.change(amt, { target: { value: '9500' } });
    fireEvent.blur(amt);
    expect(await screen.findByText(/Override/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Override/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ amountCents: 950000, derivedAmountCents: 1000000 })]));
  });

  it('cancelling the confirmation restores the derived amount', async () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    const amt = screen.getByDisplayValue('10000.00');
    fireEvent.change(amt, { target: { value: '1' } });
    fireEvent.blur(amt);
    fireEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(screen.getByDisplayValue('10000.00')).toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an overridden line shows "was $X" and Reset restores it', () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[{ ...takeoffLine, amountCents: 950000 }]} onChange={onChange} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    expect(screen.getByText(/overridden \(was \$10,000\.00\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ amountCents: 1000000 })]);
  });

  it('adds a manual line, toggles alternate, and totals exclude alternates', () => {
    const onChange = vi.fn();
    const { rerender } = wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[{ description: 'Scaffolding', amountCents: 350000 }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Add manual line/ }));
    expect(onChange).toHaveBeenLastCalledWith([takeoffLine, expect.objectContaining({ kind: 'manual', amountCents: 0 })]);
    const manual = { id: 'm1', sortOrder: 1, kind: 'manual' as const, takeoffId: null, description: 'Scaffolding', amountCents: 350000, derivedAmountCents: null, measurementSummary: null, isAlternate: false };
    rerender(<ConfirmProvider><PricingLinesCard lines={[takeoffLine, manual]} onChange={onChange} readOnly={false} takeoffTotals={[]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} /></ConfirmProvider>);
    expect(screen.getByTestId('pricing-total')).toHaveTextContent('$13,500.00');
    fireEvent.click(screen.getAllByLabelText('Alternate')[1]);
    expect(onChange).toHaveBeenLastCalledWith([takeoffLine, expect.objectContaining({ id: 'm1', isAlternate: true })]);
  });

  it('flags a missing takeoff and offers removal', () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[]} missingTakeoffIds={['t1']} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    expect(screen.getByText(/takeoff no longer exists/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Remove line/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
