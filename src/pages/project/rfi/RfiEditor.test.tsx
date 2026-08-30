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
  addRfiPhoto: vi.fn(),
  uploadProjectFile: vi.fn(),
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildRfiPdf: vi.fn(),
  getMailAccounts: vi.fn(),
  pickerProps: { last: null as any },
}));

const OK_ACCOUNT = { id: 'a1', provider: 'fake', emailAddress: 'me@bigbear.test', displayName: null, isDefault: 1, status: 'ok', unreadCount: 0 };

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getRfi: h.getRfi,
  saveRfi: h.saveRfi,
  sendRfi: h.sendRfi,
  setRfiResponse: h.setRfiResponse,
  addRfiPhoto: h.addRfiPhoto,
  uploadProjectFile: h.uploadProjectFile,
  persistGeneratedDocument: h.persistGeneratedDocument,
  getDocumentBySource: h.getDocumentBySource,
  getDocumentsBySource: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
  getMailAccounts: h.getMailAccounts,
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
  h.addRfiPhoto.mockResolvedValue(undefined);
  h.uploadProjectFile.mockResolvedValue({ fileId: 'up-photo', versioned: false });
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-9', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildRfiPdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
  h.getMailAccounts.mockResolvedValue([OK_ACCOUNT]);
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

  it('keeps Email available while dirty, and stops re-saving once the record comes back', async () => {
    const { rerender } = mount();
    expect(await screen.findByTestId('doc-send')).toBeEnabled();

    // A pending edit no longer blocks Email — the bar saves first (spec §2).
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed title' } });
    const dirtySend = screen.getByTestId('doc-send');
    expect(dirtySend).toBeEnabled();
    expect(dirtySend).not.toHaveAttribute('title', 'Save first');

    rerender(tree(rfi({ title: 'Typed title', version: 3, updatedAt: 20 })));

    // The round-tripped record must read as clean: if it still looked dirty,
    // every send would fire a redundant save of the record it just loaded.
    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));
    await waitFor(() => expect(h.sendRfi).toHaveBeenCalled());
    expect(h.saveRfi).not.toHaveBeenCalled();
  });

  // The whole app sends through the user's connected mail account now, so with
  // none connected Email must say so instead of failing at the server.
  it('blocks Email when no mail account is connected, and unblocks once one is', async () => {
    h.getMailAccounts.mockResolvedValue([]);
    mount();
    await waitFor(() => expect(screen.getByTestId('doc-send')).toBeDisabled());
    expect(screen.getByTestId('doc-send')).toHaveAttribute('title', 'Connect a mail account in Settings → Mail');

    // an account that exists but cannot send is still no account
    h.getMailAccounts.mockResolvedValue([{ ...OK_ACCOUNT, status: 'needs_review' }]);
    mount();
    await waitFor(() => expect(screen.getAllByTestId('doc-send')[1]).toBeDisabled());

    h.getMailAccounts.mockResolvedValue([OK_ACCOUNT]);
    mount();
    await waitFor(() => expect(screen.getAllByTestId('doc-send')[2]).toBeEnabled());
    expect(screen.getAllByTestId('doc-send')[2]).not.toHaveAttribute('title', 'Connect a mail account in Settings → Mail');
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

    // Every uploader on this editor is now the shared picker — no bare file
    // input is left anywhere (the modal renders in a portal, so this looks at
    // the whole document rather than the container).
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  it('keeps the response download for an RFI that already has one', async () => {
    mount(rfi({ responseFileId: 'resp-1' }));
    expect(await screen.findByRole('button', { name: /Download response/i })).toBeInTheDocument();
  });
});

describe('RfiEditor — photos', () => {
  it('adds a picked photo through the shared picker and reloads', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Add photos/i }));
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addRfiPhoto).toHaveBeenCalledWith('rfi-1', 'up-1'));
    expect(onSaved).toHaveBeenCalled();
    expect(h.pickerProps.last).toMatchObject({
      accept: 'image', defaultTab: 'upload', initialProjectIds: ['p1'],
      upload: { kind: 'rfi-photo', projectId: 'p1', sourceType: 'rfi', sourceId: 'rfi-1' },
    });
  });

  it('uploads a dropped photo, links it, then reloads', async () => {
    mount();
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(await screen.findByTestId('rfi-photo-dropzone'), { dataTransfer: { files: [shot] } });

    await waitFor(() => expect(h.uploadProjectFile).toHaveBeenCalledWith(
      'p1', shot, 'rfi-photo', { sourceType: 'rfi', sourceId: 'rfi-1' },
    ));
    await waitFor(() => expect(h.addRfiPhoto).toHaveBeenCalledWith('rfi-1', 'up-photo'));
    expect(onSaved).toHaveBeenCalled();
  });

  // Adding a photo bumps the RFI's version, which re-keys the editor and would
  // discard whatever is in the form.
  it('refuses a photo while the form is dirty, and says why', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Typed title' } });
    expect(screen.getByRole('button', { name: /Add photos/i })).toBeDisabled();

    fireEvent.drop(screen.getByTestId('rfi-photo-dropzone'), {
      dataTransfer: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] },
    });
    await screen.findByText('Save your changes first');
    expect(h.uploadProjectFile).not.toHaveBeenCalled();
  });
});
