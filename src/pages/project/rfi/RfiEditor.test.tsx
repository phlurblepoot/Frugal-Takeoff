// src/pages/project/rfi/RfiEditor.test.tsx
//
// The editor no longer owns document delivery: DocumentActionsBar does, and
// the response attachment comes from the shared file picker rather than a bare
// <input type="file"> (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Rfi } from '../../../utils/store';

const h = vi.hoisted(() => ({
  getRfi: vi.fn(),
  saveRfi: vi.fn(),
  sendRfi: vi.fn(),
  setRfiResponse: vi.fn(),
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildRfiPdf: vi.fn(),
  pickerProps: { last: null as any },
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getRfi: h.getRfi,
  saveRfi: h.saveRfi,
  sendRfi: h.sendRfi,
  setRfiResponse: h.setRfiResponse,
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

vi.mock('./rfiPdf', () => ({ buildRfiPdf: h.buildRfiPdf }));

vi.mock('../../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: () => <div data-testid="viewer" />,
}));

// Stand-in picker: records the config the editor asked for and hands back one
// picked row on demand.
vi.mock('../../../components/FilePickerModal', () => ({
  FilePickerModal: (props: any) => {
    h.pickerProps.last = props;
    return (
      <div data-testid="picker">
        <button data-testid="picker-pick" onClick={() => void props.onPick?.([{ id: 'up-1', name: 'answer.pdf' }])}>pick</button>
      </div>
    );
  },
}));

vi.mock('../../../components/EmailComposer', () => ({
  EmailComposer: ({ open, onSend, onClose }: any) =>
    open ? (
      <div data-testid="composer">
        <button
          data-testid="composer-send"
          onClick={() => {
            void onSend({ to: 'arch@example.com', subject: 's', body: 'b', attachmentFileIds: [] })
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
import { RfiEditor } from './RfiEditor';

const rfi = (over: Partial<Rfi> = {}): Rfi => ({
  id: 'rfi-1', projectId: 'p1', number: 4, title: 'Header detail',
  question: 'Which detail governs?', specRef: null, drawingRef: null,
  attention: null, responseNeededBy: null, responseText: null, responseFileId: null,
  status: 'open', version: 2, sentAt: null, answeredAt: null,
  createdAt: 1, updatedAt: 10, photos: [],
  ...over,
});

// What the server hands back after the save — deliberately different from the
// prop so "built from saved state" is falsifiable.
const SAVED = rfi({ title: 'SERVER TITLE', version: 3, updatedAt: 20, photos: [{ id: 'ph-1', fileId: 'f-photo', sortOrder: 0 }] });

const onSaved = vi.fn();

const tree = (r: Rfi) => (
  <MemoryRouter>
    <ToastProvider>
      <RfiEditor
        rfi={r}
        projectId="p1"
        projectName="Big Job"
        contractor="GC Inc"
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    </ToastProvider>
  </MemoryRouter>
);

const mount = (r: Rfi = rfi()) => render(tree(r));

beforeEach(() => {
  vi.clearAllMocks();
  h.pickerProps.last = null;
  h.getRfi.mockResolvedValue(SAVED);
  h.saveRfi.mockResolvedValue({ version: 3 });
  h.sendRfi.mockResolvedValue(undefined);
  h.setRfiResponse.mockResolvedValue(undefined);
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-9', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildRfiPdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe('RfiEditor — document actions', () => {
  it('mounts the shared bar and drops its own Download PDF / Send RFI buttons', async () => {
    mount();
    expect(await screen.findByTestId('doc-generate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Send RFI$/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('saves the draft first, then builds the PDF from the RFI the server now holds', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed title' } });

    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.saveRfi).toHaveBeenCalledTimes(1));
    expect(h.saveRfi.mock.calls[0][1]).toMatchObject({ title: 'Typed title' });

    await waitFor(() => expect(h.buildRfiPdf).toHaveBeenCalledTimes(1));
    expect(h.buildRfiPdf.mock.calls[0][0].rfi).toBe(SAVED);
    expect(h.buildRfiPdf.mock.calls[0][0].photoDataUrls).toHaveLength(1);

    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(h.persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'p1', kind: 'rfi', name: 'RFI-004.pdf',
      sourceType: 'rfi', sourceId: 'rfi-1',
    });
    expect(onSaved).toHaveBeenCalledWith({ keepMounted: true });
  });

  it('reports a failed re-read instead of storing pre-save bytes', async () => {
    h.getRfi.mockRejectedValue(new Error('offline'));
    mount();

    fireEvent.click(await screen.findByTestId('doc-generate'));

    expect(await screen.findByText('Failed to generate the PDF')).toBeInTheDocument();
    expect(h.buildRfiPdf).not.toHaveBeenCalled();
    expect(h.persistGeneratedDocument).not.toHaveBeenCalled();
  });

  it('stops blocking Email once the saved record comes back', async () => {
    const { rerender } = mount();
    expect(await screen.findByTestId('doc-send')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed title' } });
    expect(screen.getByTestId('doc-send')).toHaveAttribute('title', 'Save first');

    rerender(tree(rfi({ title: 'Typed title', version: 3, updatedAt: 20 })));

    const send = screen.getByTestId('doc-send');
    expect(send).toBeEnabled();
    expect(send).not.toHaveAttribute('title', 'Save first');
  });

  it('sends the generated file through sendRfi', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendRfi).toHaveBeenCalledTimes(1));
    expect(h.sendRfi.mock.calls[0][0]).toBe('rfi-1');
    expect(h.sendRfi.mock.calls[0][1]).toMatchObject({ to: 'arch@example.com', fileId: 'file-9' });
  });
});

describe('RfiEditor — response attachment', () => {
  it('attaches the picked file through setRfiResponse and drops the bare file input', async () => {
    mount();

    fireEvent.click(await screen.findByRole('button', { name: /Attach response/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.setRfiResponse).toHaveBeenCalledWith('rfi-1', { fileId: 'up-1' }));
    expect(onSaved).toHaveBeenCalled();

    // A global picker (no project pre-filter) that uploads into this RFI.
    expect(h.pickerProps.last).toMatchObject({
      accept: 'any', multi: false, defaultTab: 'upload',
      upload: { kind: 'rfi-response', projectId: 'p1', sourceType: 'rfi', sourceId: 'rfi-1' },
    });
    expect(h.pickerProps.last.initialProjectIds).toBeUndefined();

    // Only the photo grid's camera input remains (the modal renders in a
    // portal, so this looks at the whole document rather than the container).
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  it('keeps the response download for an RFI that already has one', async () => {
    mount(rfi({ responseFileId: 'resp-1' }));
    expect(await screen.findByRole('button', { name: /Download response/i })).toBeInTheDocument();
  });
});
