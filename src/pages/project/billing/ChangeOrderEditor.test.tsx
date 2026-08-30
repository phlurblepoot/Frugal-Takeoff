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
  addCOPhoto: vi.fn(),
  uploadProjectFile: vi.fn(),
  pickerProps: { last: null as any },
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
  addCOPhoto: h.addCOPhoto,
  uploadProjectFile: h.uploadProjectFile,
  persistGeneratedDocument: h.persistGeneratedDocument,
  getDocumentBySource: h.getDocumentBySource,
  getDocumentsBySource: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
  getMailAccounts: vi.fn(async () => []),
  pickSendableAccount: vi.fn(() => null),
  getAlwaysCc: vi.fn(async () => ''),
  getProject: vi.fn(async () => null),
  getCustomer: vi.fn(async () => undefined),
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
  getFileMeta: vi.fn(async () => null),
  getImageUrl: (id: string) => `/img/${id}`,
}));

// Stand-in picker: records the config the editor asked for and hands back one
// already-uploaded row on demand.
vi.mock('../../../components/FilePickerModal', () => ({
  FilePickerModal: (props: any) => {
    h.pickerProps.last = props;
    return (
      <div data-testid="picker">
        <button data-testid="picker-pick" onClick={() => void props.onPick?.([{ id: 'up-1', name: 'shot.png' }])}>pick</button>
      </div>
    );
  },
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

const tree = (order: ChangeOrder) => (
  <MemoryRouter>
    <ToastProvider>
      <ChangeOrderEditor
        changeOrder={order}
        onClose={vi.fn()}
        onSaved={onSaved}
        projectName="Big Job"
        projectId="p1"
      />
    </ToastProvider>
  </MemoryRouter>
);

const mount = (order: ChangeOrder = co()) => render(tree(order));

beforeEach(() => {
  vi.clearAllMocks();
  h.getChangeOrder.mockResolvedValue(SAVED);
  h.saveChangeOrder.mockResolvedValue({ version: 3 });
  h.sendChangeOrder.mockResolvedValue(undefined);
  h.pickerProps.last = null;
  h.addCOPhoto.mockResolvedValue(undefined);
  h.uploadProjectFile.mockResolvedValue({ fileId: 'up-photo', versioned: false });
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
    // The photos card's uploader is now the shared picker button.
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

  it('reports a failed re-read instead of storing pre-save bytes', async () => {
    h.getChangeOrder.mockRejectedValue(new Error('offline'));
    mount();

    fireEvent.click(await screen.findByTestId('doc-generate'));

    expect(await screen.findByText('Failed to generate the PDF')).toBeInTheDocument();
    expect(h.buildChangeOrderPdf).not.toHaveBeenCalled();
    expect(h.persistGeneratedDocument).not.toHaveBeenCalled();
  });

  it('stops reading as dirty once the saved record comes back', async () => {
    // billingStore re-INSERTs change_order_lines on every save, so the same
    // line returns with a brand-new id, and a typed "500.50" comes back as the
    // number 500.5. Neither is an unsaved edit — if either reads as one, Email
    // stays disabled on "Save first" forever.
    const loaded = co({
      lines: [{ id: 'line-old', description: 'framing', qty: 1, unitPrice: 100 }],
      lumpSumAmount: 0,
    });
    const { rerender } = mount(loaded);
    fireEvent.change(screen.getByLabelText('Lump sum'), { target: { value: '500.50' } });

    rerender(tree(co({
      version: 3,
      updatedAt: 20,
      lines: [{ id: 'line-new', description: 'framing', qty: 1, unitPrice: 100 }],
      lumpSumAmount: 500.5,
    })));

    const send = await screen.findByTestId('doc-send');
    expect(send).toBeEnabled();
    expect(send).not.toHaveAttribute('title', 'Save first');
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

describe('photo card', () => {
  it('adds a picked photo through the shared picker and reloads', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Add photos/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addCOPhoto).toHaveBeenCalledWith('co-1', 'up-1'));
    expect(onSaved).toHaveBeenCalled();
    expect(h.pickerProps.last).toMatchObject({
      accept: 'image', defaultTab: 'upload', initialProjectIds: ['p1'],
      upload: { kind: 'change-order-photo', projectId: 'p1', sourceType: 'change-order', sourceId: 'co-1' },
    });
  });

  it('uploads a dropped photo, links it, then reloads', async () => {
    mount();
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(await screen.findByTestId('change-order-photo-dropzone'), { dataTransfer: { files: [shot] } });

    await waitFor(() => expect(h.uploadProjectFile).toHaveBeenCalledWith(
      'p1', shot, 'change-order-photo', { sourceType: 'change-order', sourceId: 'co-1' },
    ));
    await waitFor(() => expect(h.addCOPhoto).toHaveBeenCalledWith('co-1', 'up-photo'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('has no bare file input left', async () => {
    mount();
    await screen.findByRole('button', { name: /Add photos/i });
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });
});
