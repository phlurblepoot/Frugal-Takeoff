// src/pages/project/billing/ChangeOrderEditor.test.tsx
// Same contract as InvoiceEditor's: the shared bar owns Generate/Open/Download/
// Send, and the PDF is built from the saved change order rather than the draft.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChangeOrder } from '../../../utils/store';

const h = vi.hoisted(() => ({
  getChangeOrder: vi.fn(),
  saveChangeOrder: vi.fn(),
  sendChangeOrder: vi.fn(),
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildChangeOrderPdf: vi.fn(),
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getChangeOrder: h.getChangeOrder,
  saveChangeOrder: h.saveChangeOrder,
  sendChangeOrder: h.sendChangeOrder,
  persistGeneratedDocument: h.persistGeneratedDocument,
  getDocumentBySource: h.getDocumentBySource,
  getDocumentsBySource: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
  getSmtpSettings: vi.fn(async () => ({})),
  getAlwaysCc: vi.fn(async () => ''),
  getProject: vi.fn(async () => null),
  getCustomer: vi.fn(async () => undefined),
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
  getFileMeta: vi.fn(async () => null),
  getImageUrl: (id: string) => `/img/${id}`,
}));

vi.mock('./changeOrderPdf', () => ({ buildChangeOrderPdf: h.buildChangeOrderPdf }));

vi.mock('../../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: () => <div data-testid="viewer" />,
}));

vi.mock('../../../components/EmailComposer', () => ({
  EmailComposer: ({ open, onSend, onClose }: any) =>
    open ? (
      <div data-testid="composer">
        <button
          data-testid="composer-send"
          onClick={() => {
            void onSend({ to: 'gc@example.com', subject: 's', body: 'b', attachmentFileIds: [] })
              .then(() => onClose())
              .catch(() => {});
          }}
        >
          send
        </button>
      </div>
    ) : null,
}));

import { ToastProvider } from '../../../components/Toast';
import { ChangeOrderEditor } from './ChangeOrderEditor';

const co = (over: Partial<ChangeOrder> = {}): ChangeOrder => ({
  id: 'co-1', projectId: 'p1', number: '001', date: null, title: 'Extra wall',
  description: null, lumpSumAmount: 0, scheduleImpactDays: null, status: 'draft',
  version: 2, createdAt: 1, updatedAt: 10, amount: 100,
  lines: [{ description: 'framing', qty: 1, unitPrice: 100 }],
  photos: [], totalCents: 10000, lumpSumCents: 0,
  ...over,
});

const SAVED = co({ title: 'SERVER TITLE', version: 3, updatedAt: 20 });

const onSaved = vi.fn();

const mount = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <ChangeOrderEditor
          changeOrder={co()}
          onClose={vi.fn()}
          onSaved={onSaved}
          projectName="Big Job"
          projectId="p1"
        />
      </ToastProvider>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.getChangeOrder.mockResolvedValue(SAVED);
  h.saveChangeOrder.mockResolvedValue({ version: 3 });
  h.sendChangeOrder.mockResolvedValue(undefined);
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-7', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildChangeOrderPdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe('ChangeOrderEditor — document actions', () => {
  it('mounts the shared bar and drops its own Download PDF button', async () => {
    mount();
    expect(await screen.findByTestId('doc-generate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save change order' })).toBeInTheDocument();
    // The photos card keeps its own uploader (Task 11 swaps the button).
    expect(screen.getByRole('button', { name: /Add photos/i })).toBeInTheDocument();
  });

  it('saves the draft first, then builds the PDF from the change order the server now holds', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Local title' } });

    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.saveChangeOrder).toHaveBeenCalledTimes(1));
    expect(h.saveChangeOrder.mock.calls[0][1]).toMatchObject({ title: 'Local title' });

    await waitFor(() => expect(h.buildChangeOrderPdf).toHaveBeenCalledTimes(1));
    expect(h.buildChangeOrderPdf.mock.calls[0][0].changeOrder).toBe(SAVED);

    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(h.persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'p1', kind: 'change-order', sourceType: 'change-order', sourceId: 'co-1',
    });
    expect(onSaved).toHaveBeenCalledWith({ keepMounted: true });
  });

  it('sends the generated file through sendChangeOrder', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendChangeOrder).toHaveBeenCalledTimes(1));
    expect(h.sendChangeOrder.mock.calls[0][0]).toBe('co-1');
    expect(h.sendChangeOrder.mock.calls[0][1]).toMatchObject({ to: 'gc@example.com', fileId: 'file-7' });
  });
});
