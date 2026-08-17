// src/pages/project/billing/AiaPayAppEditor.test.tsx
//
// The retainage-release box: clearing it is an explicit "release nothing", and
// the figures it shows are rounded so float residue never reaches the user.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AiaPayAppEditor } from './AiaPayAppEditor';
import { ToastProvider } from '../../../components/Toast';
import type { AiaG702, AiaPayApp } from '../../../utils/store';

const getPayApp = vi.hoisted(() => vi.fn());
const setPayApp = vi.hoisted(() => vi.fn());
const savePayAppLines = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/store')>();
  return { ...actual, getPayApp, setPayApp, savePayAppLines };
});

const app: AiaPayApp = {
  id: 'app2', projectId: 'p1', number: 2, periodTo: null, applicationDate: null,
  retainagePercent: 15, storedRetainagePercent: 15, releasedRetainagePoints: 5,
  status: 'draft', version: 4, createdAt: 0,
};

const g702 = (over: Partial<AiaG702['retainage']> = {}): AiaG702 => ({
  L1originalContractCents: 10000000, L2changeOrdersCents: 0, L3contractSumToDateCents: 10000000,
  L4totalCompletedStoredCents: 5000000, L5aRetainageWorkCents: 500000, L5bRetainageStoredCents: 0,
  L5retainageCents: 500000, L6earnedLessRetainageCents: 4500000, L7lessPreviousCents: 4250000,
  L8currentPaymentDueCents: 250000, L9balanceToFinishCents: 5500000,
  changeOrders: { additionsCents: 0, deductionsCents: 0, netCents: 0 },
  retainage: {
    mode: 'uniform', baseWorkPercent: 15, cumulativeReleasedPoints: 5,
    releasedThisApp: 5, remainingPoints: 15, effectiveWorkPercent: 10, ...over,
  },
});

const load = (retainageOver: Partial<AiaG702['retainage']> = {}) => ({
  app, lines: [], g703: [], g702: g702(retainageOver),
});

beforeEach(() => {
  getPayApp.mockReset();
  setPayApp.mockReset().mockResolvedValue({ version: 5 });
  savePayAppLines.mockReset().mockResolvedValue({ version: 5 });
  getPayApp.mockResolvedValue(load());
});

const renderEditor = () =>
  render(
    <ToastProvider>
      <AiaPayAppEditor payAppId="app2" onClose={vi.fn()} onSaved={vi.fn()} />
    </ToastProvider>
  );

const releaseInput = () => screen.getByLabelText(/Release retainage on this application/);

describe('AiaPayAppEditor — retainage release box', () => {
  it('treats a cleared box as releasing 0, not as "leave it alone"', async () => {
    renderEditor();
    await waitFor(() => expect(releaseInput()).toHaveValue(5));

    fireEvent.change(releaseInput(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setPayApp).toHaveBeenCalledTimes(1));
    expect(setPayApp.mock.calls[0][1]).toEqual({ releasedRetainagePoints: 0 });
  });

  it('sends no release patch when the box is left at its loaded value', async () => {
    renderEditor();
    await waitFor(() => expect(releaseInput()).toHaveValue(5));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(savePayAppLines).toHaveBeenCalledTimes(1));
    expect(setPayApp).not.toHaveBeenCalled(); // nothing changed → nothing patched
  });

  it('rounds the figures it displays and the value Release-all types in', async () => {
    getPayApp.mockResolvedValue(load({
      cumulativeReleasedPoints: 8.049999999999999,
      remainingPoints: 6.949999999999999,
      effectiveWorkPercent: 6.949999999999999,
    }));
    renderEditor();

    const releaseAll = await screen.findByRole('button', { name: 'Release all remaining (6.95%)' });
    expect(screen.getByText(/Base 15% · Released 8.05% · Effective 6.95%/)).toBeTruthy();

    fireEvent.click(releaseAll);
    expect(releaseInput()).toHaveValue(6.95);
  });
});
