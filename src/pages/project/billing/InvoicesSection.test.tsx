// src/pages/project/billing/InvoicesSection.test.tsx
// List rows carry the document's state: a chip and an Open button appear only
// for invoices that actually have a generated PDF (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { InvoiceListItem } from '../../../utils/store';

const h = vi.hoisted(() => ({
  getInvoices: vi.fn(),
  getInvoice: vi.fn(),
  getDocumentsBySource: vi.fn(),
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../ProjectLayout', () => ({
  useProjectOutlet: () => ({ summary: { name: 'Big Job', contractor: null, address: null } }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getInvoices: h.getInvoices,
  getInvoice: h.getInvoice,
  getDocumentsBySource: h.getDocumentsBySource,
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
}));

vi.mock('../../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: ({ row, onClose }: any) => (
    <div data-testid="viewer">
      <span>{row.name}</span>
      <button onClick={onClose}>close viewer</button>
    </div>
  ),
}));

// A stand-in editor that reports every mount: the section must not re-key it
// when the editor saves itself, or the document bar inside it would be torn
// down mid-flow.
const mounts = { count: 0 };
vi.mock('./InvoiceEditor', () => ({
  InvoiceEditor: ({ onSaved }: any) => {
    React.useEffect(() => { mounts.count += 1; }, []);
    return (
      <div data-testid="editor">
        <button data-testid="save-kept" onClick={() => onSaved({ keepMounted: true })}>save kept</button>
        <button data-testid="save-plain" onClick={() => onSaved()}>save plain</button>
      </div>
    );
  },
}));

import { ToastProvider } from '../../../components/Toast';
import { InvoicesSection } from './InvoicesSection';

const row = (over: Partial<InvoiceListItem> = {}): InvoiceListItem => ({
  id: 'inv-1', projectId: 'p1', number: 'INV-1', date: null, status: 'draft',
  terms: null, version: 1, createdAt: 1, updatedAt: 10,
  totalCents: 10000, paidCents: 0, balanceCents: 10000,
  ...over,
});

const FILE = { id: 'f1', name: 'Invoice-INV-1.pdf', mime: 'application/pdf', size: 12, createdAt: 50, versionNumber: 1 };

const mount = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <InvoicesSection projectId="p1" />
      </ToastProvider>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.getInvoices.mockResolvedValue([row(), row({ id: 'inv-2', number: 'INV-2' })]);
  h.getDocumentsBySource.mockResolvedValue({ 'inv-1': FILE, 'inv-2': null });
  h.getInvoice.mockResolvedValue(null);
});

describe('InvoicesSection — PDF status on rows', () => {
  it('shows a chip and an Open button only for the invoice that has a PDF', async () => {
    mount();
    await screen.findByText('INV-1');
    await waitFor(() => expect(h.getDocumentsBySource).toHaveBeenCalled());
    expect(h.getDocumentsBySource.mock.calls[0][0]).toMatchObject({
      sourceType: 'invoice', kind: 'invoice', sourceIds: ['inv-1', 'inv-2'],
    });

    await waitFor(() => expect(screen.getByText('PDF up to date')).toBeInTheDocument());
    expect(screen.queryByText('No PDF yet')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open PDF' })).toHaveLength(1);
  });

  it('marks the chip out of date when the invoice changed after the PDF was made', async () => {
    h.getDocumentsBySource.mockResolvedValue({ 'inv-1': { ...FILE, createdAt: 5 }, 'inv-2': null });
    mount();
    await waitFor(() => expect(screen.getByText('PDF out of date')).toBeInTheDocument());
  });

  it('opens the viewer instead of the editor when Open is clicked', async () => {
    mount();
    const open = await screen.findByRole('button', { name: 'Open PDF' });
    fireEvent.click(open);

    expect(await screen.findByTestId('viewer')).toBeInTheDocument();
    expect(screen.getByText('Invoice-INV-1.pdf')).toBeInTheDocument();
    expect(h.getInvoice).not.toHaveBeenCalled();
  });
});

describe('InvoicesSection — editor remounting', () => {
  it('keeps the editor mounted for its own saves and re-keys it for outside refreshes', async () => {
    h.getInvoice.mockResolvedValue({ ...row(), lines: [], payments: [] });
    mounts.count = 0;
    mount();

    fireEvent.click(await screen.findByText('INV-1'));
    await screen.findByTestId('editor');
    await waitFor(() => expect(mounts.count).toBe(1));

    // act() flushes the reload's promises and the resulting render, so a
    // remount would already have happened by the time we count.
    await act(async () => { fireEvent.click(screen.getByTestId('save-kept')); });
    expect(h.getInvoice).toHaveBeenCalledTimes(2); // open + reload
    expect(mounts.count).toBe(1);

    // A refresh that found nothing new must not throw away a typed draft.
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(1);

    // A record that actually moved on does re-key the editor.
    h.getInvoice.mockResolvedValue({ ...row({ version: 2 }), lines: [], payments: [] });
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(2);
  });
});
