// src/pages/project/rfi/RfiEditor.test.tsx
//
// The editor no longer owns document delivery: DocumentActionsBar does, and
// the response attachment comes from the shared file picker rather than a bare
// <input type="file"> (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
  acceptRfiPendingReply: vi.fn(),
  dismissRfiPendingReply: vi.fn(),
  mailAccounts: vi.fn(),
  mailLinks: vi.fn(),
  mailThread: vi.fn(),
  pickerProps: { last: null as any },
  bannerProps: { last: null as any },
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
  acceptRfiPendingReply: h.acceptRfiPendingReply,
  dismissRfiPendingReply: h.dismissRfiPendingReply,
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

// The bar's own composer is the shared mail composer now; the stub resolves a
// SendRequest exactly as the real one does once the user hits Send.
vi.mock('../../../pages/mail/compose/MailComposer', async (orig) => ({
  ...(await orig<typeof import('../../../pages/mail/compose/MailComposer')>()),
  MailComposer: ({ open, onSend, onClose }: any) =>
    open ? (
      <div data-testid="composer">
        <button
          data-testid="composer-send"
          onClick={() => {
            void onSend({ to: [{ addr: 'arch@example.com' }], subject: 's', html: '<p>b</p>', attachments: [] })
              .then(() => onClose())
              .catch(() => {});
          }}
        >
          send
        </button>
      </div>
    ) : null,
}));

// The document bar loads the user's mailboxes (for the composer's From select)
// and the item's mail thread links (for the Sent chip). Neither is under test
// here; an empty mailbox list is the honest default.
vi.mock('../../../utils/mailApi', () => ({
  mailApi: { accounts: h.mailAccounts, links: h.mailLinks, thread: h.mailThread },
}));

// The banner is covered by its own test; here it stands in as a probe for the
// props the editor computes (chiefly canOpenThread) and a way to fire its
// callbacks.
vi.mock('./PendingReplyBanner', () => ({
  PendingReplyBanner: (props: any) => {
    h.bannerProps.last = props;
    return (
      <div data-testid="pending-banner">
        <button data-testid="banner-use" onClick={() => props.onUseAsResponse(props.rfi.pendingReply.text)}>use</button>
        <button data-testid="banner-open-thread" onClick={() => props.onOpenThread()}>open thread</button>
        <button data-testid="banner-accepted" onClick={() => props.onAccepted()}>accepted</button>
        <span data-testid="banner-draft">{props.draftText ?? '(none)'}</span>
      </div>
    );
  },
}));

import { ToastProvider } from '../../../components/Toast';
import { RfiEditor } from './RfiEditor';
import { __resetThreadProbeCache } from '../../../hooks/useItemThreadLinks';

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
  h.acceptRfiPendingReply.mockResolvedValue({ status: 'answered' });
  h.dismissRfiPendingReply.mockResolvedValue(undefined);
  h.mailAccounts.mockResolvedValue([]);
  h.mailLinks.mockResolvedValue([]);
  h.mailThread.mockRejectedValue(new Error('not found'));
  h.bannerProps.last = null;
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

// ---------------------------------------------------------------------------
// Inbound email reply (mail client Plan 4). An emailed answer is captured
// against the RFI but stays pending until a human accepts it here.

const PENDING = {
  threadKey: 'thr-1', accountId: 'acct-1', mailMessageId: 'msg-1', messageIdHeader: 'm1@teg.com',
  from: { addr: 'gc@teg.com', name: 'Mike Ruiz' },
  date: '2026-08-28T10:00:00.000Z',
  text: 'Corridor is 9 ft per the RCP.',
  attachments: [], receivedAt: '2026-08-28T10:00:05.000Z',
};

const sentWithReply = (over: Partial<Rfi> = {}) =>
  rfi({ status: 'sent', sentAt: 5, pendingReply: PENDING, ...over });

describe('RfiEditor — pending email reply', () => {
  beforeEach(() => { __resetThreadProbeCache(); });

  it('shows the banner for a sent RFI that has a pending reply', async () => {
    mount(sentWithReply());
    expect(await screen.findByTestId('pending-banner')).toBeInTheDocument();
    expect(h.bannerProps.last).toMatchObject({ projectId: 'p1' });
    expect(h.bannerProps.last.rfi.pendingReply).toEqual(PENDING);
  });

  // A pendingReply row can outlive an out-of-band status change; the status is
  // the authority on whether an answer is still awaited.
  it('hides the banner once the RFI has moved past sent', () => {
    mount(sentWithReply({ status: 'answered' }));
    expect(screen.queryByTestId('pending-banner')).toBeNull();
  });

  it('hides the banner when nothing is pending', () => {
    mount(rfi({ status: 'sent' }));
    expect(screen.queryByTestId('pending-banner')).toBeNull();
  });

  it('Use as response fills the response textarea', async () => {
    mount(sentWithReply());
    fireEvent.click(await screen.findByTestId('banner-use'));
    expect((screen.getByLabelText(/Response text/i) as HTMLTextAreaElement).value)
      .toBe('Corridor is 9 ft per the RCP.');
  });

  // Accepting and editing the text are one action: the same Save button, but
  // routed to the accept endpoint so the pending reply is cleared and the
  // response is recorded as email-sourced.
  it('Save response text accepts the pending reply instead of setting a plain response', async () => {
    mount(sentWithReply());
    fireEvent.click(await screen.findByTestId('banner-use'));
    fireEvent.change(screen.getByLabelText(/Response text/i), { target: { value: 'Corridor is 9 ft (confirmed).' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save response text' }));

    await waitFor(() => expect(h.acceptRfiPendingReply).toHaveBeenCalledWith('rfi-1', { text: 'Corridor is 9 ft (confirmed).' }));
    expect(h.setRfiResponse).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it('the main Save also accepts, so the pending reply is never left behind', async () => {
    mount(sentWithReply());
    fireEvent.click(await screen.findByTestId('banner-use'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(h.saveRfi).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.acceptRfiPendingReply).toHaveBeenCalledWith('rfi-1', { text: 'Corridor is 9 ft per the RCP.' }));
    expect(h.setRfiResponse).not.toHaveBeenCalled();
  });

  // Someone else accepted or dismissed the reply while this draft was open.
  // The text on screen is still what the user means to record and there is no
  // pending row left to clear, so it must land as an ordinary response rather
  // than being thrown away with an error.
  it('falls back to a plain response write when the reply vanished, keeping the edit', async () => {
    const gone = new Error('No pending reply to accept');
    gone.name = 'NoPendingReplyError';
    h.acceptRfiPendingReply.mockRejectedValue(gone);
    mount(sentWithReply());
    fireEvent.click(await screen.findByTestId('banner-use'));
    fireEvent.change(screen.getByLabelText(/Response text/i), { target: { value: 'Corridor is 9 ft (confirmed).' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save response text' }));

    await waitFor(() => expect(h.setRfiResponse).toHaveBeenCalledWith('rfi-1', { text: 'Corridor is 9 ft (confirmed).' }));
    expect(await screen.findByText(/already handled — saving your text as the response/)).toBeInTheDocument();
    // The edit survives: it was saved, and it is still on screen.
    expect((screen.getByLabelText(/Response text/i) as HTMLTextAreaElement).value).toBe('Corridor is 9 ft (confirmed).');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  // A request that simply failed is different: nothing was recorded, so the
  // typed draft is the only copy of it and the refresh must not re-key the
  // editor out from under it.
  it('keeps the editor mounted when the response write fails outright', async () => {
    h.acceptRfiPendingReply.mockRejectedValue(new Error('network down'));
    mount(sentWithReply());
    fireEvent.click(await screen.findByTestId('banner-use'));
    fireEvent.change(screen.getByLabelText(/Response text/i), { target: { value: 'Corridor is 9 ft (confirmed).' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save response text' }));

    expect(await screen.findByText('Failed to save response')).toBeInTheDocument();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ keepMounted: true }));
    expect((screen.getByLabelText(/Response text/i) as HTMLTextAreaElement).value).toBe('Corridor is 9 ft (confirmed).');
  });

  // The banner hands the editor's own draft back on the accept-with-file path,
  // but only once Use as response put it there — a hand-typed note is not this
  // reply's text.
  it('passes the draft to the banner only after Use as response', async () => {
    mount(sentWithReply());
    await screen.findByTestId('pending-banner');
    expect(screen.getByTestId('banner-draft')).toHaveTextContent('(none)');

    fireEvent.click(screen.getByTestId('banner-use'));
    fireEvent.change(screen.getByLabelText(/Response text/i), { target: { value: 'Corridor is 9 ft (confirmed).' } });
    expect(screen.getByTestId('banner-draft')).toHaveTextContent('Corridor is 9 ft (confirmed).');
  });

  // The banner already accepted (text + file in one call), so the pending row
  // is gone: a later Save must not try to accept again.
  it('stops accepting once the banner accepted on its own', async () => {
    mount(sentWithReply());
    fireEvent.click(await screen.findByTestId('banner-use'));
    fireEvent.click(screen.getByTestId('banner-accepted'));
    expect(onSaved).toHaveBeenCalledWith({ keepMounted: true });

    fireEvent.change(screen.getByLabelText(/Response text/i), { target: { value: 'Corridor is 9 ft.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save response text' }));
    await waitFor(() => expect(h.setRfiResponse).toHaveBeenCalledWith('rfi-1', { text: 'Corridor is 9 ft.' }));
    expect(h.acceptRfiPendingReply).not.toHaveBeenCalled();
  });

  // The record still saved — only the response write failed. Calling the whole
  // thing a failure would send the user back to redo stored work, and a re-key
  // would take the unsaved response text with it.
  it('reports a failed response write without calling the whole save a failure', async () => {
    h.acceptRfiPendingReply.mockRejectedValue(new Error('network down'));
    mount(sentWithReply());
    fireEvent.click(await screen.findByTestId('banner-use'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(h.saveRfi).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('The RFI saved, but the response text did not')).toBeInTheDocument();
    expect(screen.queryByText('Save failed')).toBeNull();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ keepMounted: true }));
  });

  // A response text typed WITHOUT touching the banner is still an ordinary
  // response — accept is only for the reply the banner offered.
  it('keeps the plain response path for text typed by hand', async () => {
    mount(sentWithReply());
    fireEvent.change(await screen.findByLabelText(/Response text/i), { target: { value: 'Called the architect.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save response text' }));

    await waitFor(() => expect(h.setRfiResponse).toHaveBeenCalledWith('rfi-1', { text: 'Called the architect.' }));
    expect(h.acceptRfiPendingReply).not.toHaveBeenCalled();
  });

  describe('thread access', () => {
    const mountRouted = (r: Rfi) =>
      render(
        <MemoryRouter initialEntries={['/project/p1/rfis']}>
          <ToastProvider>
            <Routes>
              <Route path="/project/:projectId/rfis" element={
                <RfiEditor rfi={r} projectId="p1" projectName="Big Job" contractor="GC Inc" onClose={vi.fn()} onSaved={onSaved} />
              } />
              <Route path="/mail/:accountId/:folderId/:threadKey" element={<div data-testid="mail-page" />} />
            </Routes>
          </ToastProvider>
        </MemoryRouter>
      );

    // The reply landed in the mailbox of whoever sent the RFI. For anyone else
    // the mail routes 403/404, so the banner must be told it cannot deep-link.
    it('cannot open the thread when the receiving mailbox is not one of ours', async () => {
      mountRouted(sentWithReply());
      await screen.findByTestId('pending-banner');
      await waitFor(() => expect(h.mailLinks).toHaveBeenCalled());
      expect(h.bannerProps.last.canOpenThread).toBe(false);
    });

    it('opens the thread in the receiving mailbox when the user owns it', async () => {
      h.mailAccounts.mockResolvedValue([{ ...OK_ACCOUNT, id: 'acct-1' }]);
      mountRouted(sentWithReply());
      await screen.findByTestId('pending-banner');
      await waitFor(() => expect(h.bannerProps.last.canOpenThread).toBe(true));

      fireEvent.click(screen.getByTestId('banner-open-thread'));
      expect(await screen.findByTestId('mail-page')).toBeInTheDocument();
    });
  });
});
