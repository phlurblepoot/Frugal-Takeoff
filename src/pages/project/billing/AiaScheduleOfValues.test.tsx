// src/pages/project/billing/AiaScheduleOfValues.test.tsx
//
// The SOV can be seeded from a spreadsheet. Until now that spreadsheet had to
// come off the local disk, even when the very same workbook was already filed
// under Documents — so the import now accepts a picked document and runs the
// identical column A/column B parse over its bytes
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { ToastProvider } from '../../../components/Toast';
import { ConfirmProvider } from '../../../components/ConfirmDialog';

const h = vi.hoisted(() => ({
  pickers: new Map<string, any>(),
  getSov: vi.fn(async () => [] as any[]),
  seedSov: vi.fn(async (_p: string, lines: any[]) => ({ count: lines.length })),
}));

vi.mock('../../../components/documents/AddFilesButton', () => ({
  AddFilesButton: (props: any) => {
    h.pickers.set(props.label, props);
    return <button data-testid={`picker-${props.label}`}>{props.label}</button>;
  },
}));
vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));
vi.mock('../../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../../utils/store')>()),
  getSov: h.getSov,
  seedSov: h.seedSov,
  syncChangeOrders: vi.fn(async () => ({ added: 0 })),
  getProject: vi.fn(async () => null),
}));

import { AiaScheduleOfValues } from './AiaScheduleOfValues';

const sheetBlob = (rows: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'SOV');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
};

const row = { id: 'doc-1', name: 'SOV.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

const mount = () => render(
  <ToastProvider>
    <ConfirmProvider>
      <AiaScheduleOfValues projectId="p1" aiaSettings={null} />
    </ConfirmProvider>
  </ToastProvider>
);

beforeEach(() => { h.pickers.clear(); vi.clearAllMocks(); h.getSov.mockResolvedValue([]); });

describe('AiaScheduleOfValues — import from documents', () => {
  it('offers a single-pick spreadsheet picker that returns bytes', async () => {
    await act(async () => { mount(); });
    const props = h.pickers.get('Import from documents');
    expect(props).toBeTruthy();
    expect(props.accept).toBe('spreadsheet');
    expect(props.multi).toBe(false);
    expect(props.returnBlobs).toBe(true);
    expect(props.initialProjectIds).toEqual(['p1']);
    // The disk upload stays — this is an extra route in, not a replacement.
    expect(screen.getByRole('button', { name: /Upload sheet/i })).toBeInTheDocument();
  });

  it('parses the picked workbook into schedule-of-values lines', async () => {
    await act(async () => { mount(); });
    await act(async () => {
      await h.pickers.get('Import from documents').onPickBlobs([{
        row,
        blob: sheetBlob([
          ['Description', 'Value'],
          ['Lath & scratch', '12,500.00'],
          ['Brown coat', 8000],
          ['', ''],
        ]),
      }]);
    });
    await waitFor(() => expect(h.seedSov).toHaveBeenCalledWith('p1', [
      { description: 'Lath & scratch', scheduledValueCents: 1250000 },
      { description: 'Brown coat', scheduledValueCents: 800000 },
    ]));
  });

  it('reports a workbook with no usable rows instead of wiping the SOV', async () => {
    await act(async () => { mount(); });
    await act(async () => {
      await h.pickers.get('Import from documents').onPickBlobs([{
        row, blob: sheetBlob([['Description', 'Value'], ['no value here', 'n/a']]),
      }]);
    });
    expect(h.seedSov).not.toHaveBeenCalled();
    expect(await screen.findByText(/No valid rows found/i)).toBeInTheDocument();
  });
});
