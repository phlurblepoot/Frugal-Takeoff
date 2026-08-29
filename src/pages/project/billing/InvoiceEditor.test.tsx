// src/pages/project/billing/InvoiceEditor.test.tsx
//
// The editor no longer owns document delivery: DocumentActionsBar does
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
// What stays the editor's job — and is what these tests pin — is handing the
// bar a `build()` that reads the SAVED invoice, never the typed-in draft.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Invoice } from '../../../utils/store';

const h = vi.hoisted(() => ({
  getInvoice: vi.fn(),
  saveInvoice: vi.fn(),
  sendInvoice: vi.fn(),
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildInvoicePdf: vi.fn(),
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getInvoice: h.getInvoice,
  saveInvoice: h.saveInvoice,
  sendInvoice: h.sendInvoice,
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
}));

vi.mock('./invoicePdf', () => ({ buildInvoicePdf: h.buildInvoicePdf }));

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
            void onSend({ to: 'client@example.com', subject: 's', body: 'b', attachmentFileIds: [] })
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
import { InvoiceEditor } from './InvoiceEditor';

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: 'inv-1', projectId: 'p1', number: 'INV-1', date: null, status: 'draft',
  terms: null, version: 2, createdAt: 1, updatedAt: 10,
  lines: [{ description: 'work', qty: 1, unitPrice: 100 }],
  payments: [], totalCents: 10000, paidCents: 0, balanceCents: 10000,
  ...over,
});

// What the server hands back after the save — deliberately different from the
// prop so "built from saved state" is falsifiable.
const SAVED = invoice({ number: 'SERVER-9', version: 3, updatedAt: 20 });

const onSaved = vi.fn();

const tree = (inv: Invoice) => (
  <MemoryRouter>
    <ToastProvider>
      <InvoiceEditor
        invoice={inv}
        onClose={vi.fn()}
        onSaved={onSaved}
        projectName="Big Job"
        projectId="p1"
      />
    </ToastProvider>
  </MemoryRouter>
);

const mount = (inv: Invoice = invoice()) => render(tree(inv));

beforeEach(() => {
  vi.clearAllMocks();
  h.getInvoice.mockResolvedValue(SAVED);
  h.saveInvoice.mockResolvedValue({ version: 3 });
  h.sendInvoice.mockResolvedValue(undefined);
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-9', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildInvoicePdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe('InvoiceEditor — document actions', () => {
  it('mounts the shared bar and drops its own Download PDF button', async () => {
    mount();
    expect(await screen.findByTestId('doc-generate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    // Close/Save stay the editor's own.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save invoice' })).toBeInTheDocument();
  });

  it('saves the draft first, then builds the PDF from the invoice the server now holds', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Number'), { target: { value: 'INV-2' } });

    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.saveInvoice).toHaveBeenCalledTimes(1));
    expect(h.saveInvoice.mock.calls[0][1]).toMatchObject({ number: 'INV-2' });

    await waitFor(() => expect(h.buildInvoicePdf).toHaveBeenCalledTimes(1));
    // Not the prop (INV-1) and not the local draft (INV-2) — the saved record.
    expect(h.buildInvoicePdf.mock.calls[0][0].invoice).toBe(SAVED);

    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(h.persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-1',
    });
    // The parent refreshes without re-keying the editor, so the bar survives
    // its own save-then-generate flow.
    expect(onSaved).toHaveBeenCalledWith({ keepMounted: true });
  });

  it('reports a failed re-read instead of storing pre-save bytes', async () => {
    h.getInvoice.mockRejectedValue(new Error('offline'));
    mount();

    fireEvent.click(await screen.findByTestId('doc-generate'));

    expect(await screen.findByText('Failed to generate the PDF')).toBeInTheDocument();
    expect(h.buildInvoicePdf).not.toHaveBeenCalled();
    expect(h.persistGeneratedDocument).not.toHaveBeenCalled();
  });

  it('stops reading as dirty when the saved record comes back with re-minted line ids', async () => {
    // billingStore re-INSERTs invoice_lines on every save, so the same line
    // returns with a brand-new id — which must not read as an unsaved edit, or
    // Email stays disabled on "Save first" forever.
    const loaded = invoice({ lines: [{ id: 'line-old', description: 'work', qty: 1, unitPrice: 100 }] });
    const { rerender } = mount(loaded);
    expect(await screen.findByTestId('doc-send')).toBeEnabled();

    rerender(tree(invoice({
      version: 3,
      updatedAt: 20,
      lines: [{ id: 'line-new', description: 'work', qty: 1, unitPrice: 100 }],
    })));

    const send = screen.getByTestId('doc-send');
    expect(send).toBeEnabled();
    expect(send).not.toHaveAttribute('title', 'Save first');
  });

  it('sends the generated file through sendInvoice', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendInvoice).toHaveBeenCalledTimes(1));
    expect(h.sendInvoice.mock.calls[0][0]).toBe('inv-1');
    expect(h.sendInvoice.mock.calls[0][1]).toMatchObject({ to: 'client@example.com', fileId: 'file-9' });
  });
});
