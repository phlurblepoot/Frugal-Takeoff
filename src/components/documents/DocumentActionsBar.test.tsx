// src/components/documents/DocumentActionsBar.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DocumentActionsBar, DocumentActionsBarProps } from './DocumentActionsBar';

const h = vi.hoisted(() => ({
  state: {
    file: null as null | { id: string; name: string | null; mime: string; size: number; createdAt: number; versionNumber: number },
    upToDate: null as boolean | null,
    loading: false,
    refresh: vi.fn(async () => {}),
  },
  // What the (stubbed) composer resolves and hands to onSend.
  sendReq: null as unknown,
  composerProps: { last: null as any },
  threads: {
    links: [] as unknown[],
    newest: null as unknown,
    myThread: null as unknown,
    loading: false,
    resolving: false,
    reload: vi.fn(),
  },
  accounts: [] as unknown[],
  accountsLoading: false,
  // Whatever the composer's onSend rejected with — how a test observes that an
  // awaited version choice actually settled.
  sendErrors: [] as unknown[],
  toast: vi.fn(),
}));

vi.mock('../../hooks/useGeneratedDocument', () => ({
  useGeneratedDocument: () => h.state,
}));

vi.mock('../Toast', () => ({ useToast: () => ({ toast: h.toast }) }));

vi.mock('../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../utils/store')>()),
  persistGeneratedDocument: vi.fn(async () => ({ fileId: 'new-file', versioned: true })),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'], { type: 'application/pdf' })),
  getFileMeta: vi.fn(async () => ({
    id: 'f1', projectId: 'p1', name: 'Invoice-12.pdf', mime: 'application/pdf',
    size: 10, kind: 'invoice', parentFileId: null, versionNumber: 2, createdAt: 5,
  })),
  getDocumentTypes: vi.fn(async () => []),
}));

vi.mock('../../utils/download', () => ({ downloadBlob: vi.fn() }));

vi.mock('../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: ({ row, onClose }: any) => (
    <div data-testid="viewer">
      <span>{row.name}</span>
      <button onClick={onClose}>close viewer</button>
    </div>
  ),
}));

vi.mock('../../pages/mail/useMailAccounts', () => ({
  useMailAccounts: () => ({ accounts: h.accounts, loading: h.accountsLoading, reload: vi.fn() }),
}));

vi.mock('../../hooks/useItemThreadLinks', () => ({
  useItemThreadLinks: () => h.threads,
}));

vi.mock('../../pages/mail/compose/MailComposer', async (orig) => ({
  // itemTypeFromSource is a pure mapping the bar depends on — keep the real one.
  ...(await orig<typeof import('../../pages/mail/compose/MailComposer')>()),
  // Mirrors the real composer closely enough for the flows under test: it
  // closes only when onSend resolves, and (like every Modal) closes on a
  // window-level Escape — which is exactly the collision the bar has to guard.
  MailComposer: (props: any) => {
    const { open, onSend, onClose, primaryAttachment, extraHeader } = props;
    h.composerProps.last = props;
    React.useEffect(() => {
      if (!open) return;
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);
    return open ? (
      <div data-testid="composer">
        <span data-testid="composer-attachment">{primaryAttachment?.name}</span>
        {extraHeader}
        {/* Mirrors the real composer: it closes only when onSend resolves,
            and stays open (message intact) when onSend rejects. */}
        <button
          data-testid="composer-send"
          onClick={() => { void onSend(h.sendReq).then(() => onClose()).catch((e: unknown) => { h.sendErrors.push(e); }); }}
        >
          send
        </button>
      </div>
    ) : null;
  },
}));

import { persistGeneratedDocument, fetchFileBlob, getFileMeta } from '../../utils/store';
import type { SendRequest, ThreadLink } from '../../pages/mail/types';
import { downloadBlob } from '../../utils/download';
import { DocumentGenerationCancelled } from './errors';

const FILE = { id: 'f1', name: 'Invoice-12.pdf', mime: 'application/pdf', size: 10, createdAt: 5, versionNumber: 2 };

const SEND_REQUEST: SendRequest = {
  to: [{ addr: 'client@example.com' }],
  subject: 'Invoice 12',
  html: '<p>Attached</p>',
  attachments: [],
};

const LINK: ThreadLink = {
  id: 'l1', threadKey: 'tk-1', subjectSnapshot: 'Invoice 12', firstDate: '2026-08-27T12:00:00.000Z',
  participantsJson: null, itemType: 'invoice', itemId: 'inv-1', projectId: 'p1', customerId: null,
  linkedByUserId: 'u1', createdAt: '2026-08-27T12:00:00.000Z',
};

const build = vi.fn(async () => new Blob(['pdf'], { type: 'application/pdf' }));
const save = vi.fn(async () => true);
const sendFn = vi.fn(async (_fileId: string, _req: SendRequest) => undefined);
const onGenerated = vi.fn();

const sendProp = (over: Partial<NonNullable<DocumentActionsBarProps['send']>> = {}) => ({
  composer: { defaultSubject: 'Invoice 12', defaultBody: 'Attached', defaultTo: 'client@example.com' },
  sendFn,
  ...over,
});

const renderBar = (over: Partial<DocumentActionsBarProps> = {}) =>
  render(
    <MemoryRouter>
      <DocumentActionsBar
        source={{ sourceType: 'invoice', sourceId: 'inv-1' }}
        kind="invoice"
        format="pdf"
        projectId="p1"
        fileName="Invoice-12.pdf"
        build={build}
        dirty={false}
        save={save}
        updatedAt={1}
        onGenerated={onGenerated}
        {...over}
      />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.state.file = null;
  h.state.upToDate = null;
  h.sendReq = SEND_REQUEST;
  h.composerProps.last = null;
  h.accounts = [];
  h.accountsLoading = false;
  h.threads.newest = null;
  h.threads.myThread = null;
  h.threads.links = [];
  h.sendErrors.length = 0;
  save.mockResolvedValue(true);
  (persistGeneratedDocument as any).mockResolvedValue({ fileId: 'new-file', versioned: true });
});

describe('DocumentActionsBar — generate', () => {
  it('with no file: shows the empty chip, hides Open/Download, and generates without a mode', async () => {
    renderBar();
    expect(screen.getByTestId('doc-status')).toHaveTextContent('No PDF yet');
    expect(screen.queryByTestId('doc-open')).toBeNull();
    expect(screen.queryByTestId('doc-download')).toBeNull();

    fireEvent.click(screen.getByTestId('doc-generate'));

    await waitFor(() => expect(persistGeneratedDocument).toHaveBeenCalled());
    expect(build).toHaveBeenCalled();
    const opts = (persistGeneratedDocument as any).mock.calls[0][1];
    expect(opts).toMatchObject({ projectId: 'p1', kind: 'invoice', name: 'Invoice-12.pdf', sourceType: 'invoice', sourceId: 'inv-1' });
    expect(opts.mode).toBeUndefined();
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith('new-file'));
    expect(h.state.refresh).toHaveBeenCalled();
  });

  it('saves an unsaved editor first, and aborts when the save fails', async () => {
    save.mockResolvedValue(false);
    renderBar({ dirty: true });
    fireEvent.click(screen.getByTestId('doc-generate'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Save failed — nothing generated', expect.anything()));
    expect(persistGeneratedDocument).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('asks version-or-overwrite when a file already exists', async () => {
    h.state.file = FILE;
    h.state.upToDate = true;
    const { unmount } = renderBar();

    fireEvent.click(screen.getByTestId('doc-generate'));
    await screen.findByText('Replace the existing PDF?');
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect((persistGeneratedDocument as any).mock.calls[0][1].mode).toBe('overwrite'));
    unmount();

    vi.clearAllMocks();
    const second = renderBar();
    fireEvent.click(screen.getByTestId('doc-generate'));
    await screen.findByText('Replace the existing PDF?');
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    await waitFor(() => expect((persistGeneratedDocument as any).mock.calls[0][1].mode).toBe('version'));
    second.unmount();

    vi.clearAllMocks();
    renderBar();
    fireEvent.click(screen.getByTestId('doc-generate'));
    await screen.findByText('Replace the existing PDF?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Replace the existing PDF?')).toBeNull());
    expect(persistGeneratedDocument).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });
});

describe('DocumentActionsBar — send', () => {
  it('reuses an up-to-date file instead of rebuilding', async () => {
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar({ send: sendProp() });

    fireEvent.click(screen.getByTestId('doc-send'));
    expect(screen.getByTestId('composer-attachment')).toHaveTextContent('Invoice-12.pdf');
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect(sendFn.mock.calls[0][0]).toBe('f1');
    expect(build).not.toHaveBeenCalled();
    expect(persistGeneratedDocument).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('composer')).toBeNull());
  });

  it('rebuilds a stale file through the version dialog and sends the new id', async () => {
    h.state.file = FILE;
    h.state.upToDate = false;
    renderBar({ send: sendProp() });

    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(screen.getByTestId('composer-send'));

    await screen.findByText('Replace the existing PDF?');
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));

    await waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect(build).toHaveBeenCalled();
    expect((persistGeneratedDocument as any).mock.calls[0][1].mode).toBe('version');
    expect(onGenerated).toHaveBeenCalledWith('new-file');
    expect(sendFn.mock.calls[0][0]).toBe('new-file');
  });

  it('rebuilds an up-to-date file when the header email is overridden', async () => {
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar({
      send: sendProp({
        composer: {
          defaultSubject: 'Invoice 12',
          defaultBody: 'Attached',
          defaultHeaderEmail: 'me@example.com',
          headerEmailOptions: [{ label: 'me', value: 'me@example.com' }, { label: 'other', value: 'other@example.com' }],
        },
      }),
    });

    fireEvent.click(screen.getByTestId('doc-send'));
    // The select is the bar's own, rendered into the composer's extraHeader slot.
    fireEvent.change(screen.getByTestId('doc-header-email').querySelector('select')!, {
      target: { value: 'other@example.com' },
    });
    fireEvent.click(screen.getByTestId('composer-send'));

    await screen.findByText('Replace the existing PDF?');
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(build).toHaveBeenCalledWith({ headerEmail: 'other@example.com' }));
    await waitFor(() => expect(sendFn.mock.calls[0][0]).toBe('new-file'));
  });

  it('settles the awaited version choice when the bar unmounts mid-send', async () => {
    h.state.file = FILE;
    h.state.upToDate = false;
    const { unmount } = renderBar({ send: sendProp() });

    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(screen.getByTestId('composer-send'));
    await screen.findByText('Replace the existing PDF?');

    // The host went away (an editor remount, a closed modal) while the choice
    // was pending: the promise must settle as a cancel, not dangle forever.
    unmount();

    await waitFor(() => expect(h.sendErrors).toHaveLength(1));
    expect(h.sendErrors[0]).toBeInstanceOf(DocumentGenerationCancelled);
    expect(build).not.toHaveBeenCalled();
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('keeps the composer open when the version dialog is cancelled mid-send', async () => {
    h.state.file = FILE;
    h.state.upToDate = false;
    renderBar({ send: sendProp() });

    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(screen.getByTestId('composer-send'));

    await screen.findByText('Replace the existing PDF?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Replace the existing PDF?')).toBeNull());
    expect(sendFn).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
  });

  // Spec §2: Generate AND Send save first. A dirty editor no longer blocks
  // Send — it commits, then builds from the saved record.
  it('saves a dirty editor before building and sending', async () => {
    h.state.file = FILE;
    // The honest pre-save value: the hook still calls the stored file current,
    // because the edit that will move the record past it hasn't been written
    // yet. handleSend must not trust it (it is captured in the render closure
    // and never re-read after the save).
    h.state.upToDate = true;
    renderBar({ dirty: true, send: sendProp() });

    const btn = screen.getByTestId('doc-send');
    expect(btn).toBeEnabled();
    expect(btn).not.toHaveAttribute('title', 'Save first');

    fireEvent.click(btn);
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    // The stored file predates the pending edit, so it can't be reused: the
    // dialog is how the freshly saved record gets its document.
    await screen.findByText('Replace the existing PDF?');
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(build.mock.invocationCallOrder[0]);
    expect(sendFn.mock.calls[0][0]).toBe('new-file');
  });

  it('never emails the pre-edit file when a save was needed', async () => {
    // Regression: `upToDate` is read from the render closure, so it still says
    // "current" after saveFirst() has moved the record — sending would have
    // attached the PDF of the text the user just changed.
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar({ dirty: true, send: sendProp() });

    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    await screen.findByText('Replace the existing PDF?');
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect(build).toHaveBeenCalled();
    expect(sendFn.mock.calls[0][0]).toBe('new-file');
    expect(sendFn.mock.calls[0][0]).not.toBe(FILE.id);
  });

  it('sends nothing when the save fails, and leaves the composer open', async () => {
    save.mockResolvedValue(false);
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar({ dirty: true, send: sendProp() });

    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Save failed — nothing sent', expect.anything()));
    expect(sendFn).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(persistGeneratedDocument).not.toHaveBeenCalled();
    // The sentinel keeps the typed message on screen instead of reporting a
    // send failure the user can't act on.
    await waitFor(() => expect(h.sendErrors).toHaveLength(1));
    expect(h.sendErrors[0]).toBeInstanceOf(DocumentGenerationCancelled);
    expect(screen.getByTestId('composer')).toBeInTheDocument();
  });

  it('still blocks Send for a caller-supplied reason', () => {
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar({ dirty: true, send: sendProp({ blockedReason: 'Add a recipient first' }) });
    const blocked = screen.getByTestId('doc-send');
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('title', 'Add a recipient first');
  });
});

// A record with no updatedAt (the project-level punch report) has no clock to
// compare a stored file against. isUpToDate reports `true` for a missing
// updatedAt, so without this the chip would claim freshness it cannot know and
// Send would mail an old file forever.
describe('DocumentActionsBar — staleness unknown', () => {
  it('makes no freshness claim in the chip', () => {
    const { unmount } = renderBar({ updatedAt: null, staleness: 'unknown' });
    expect(screen.getByTestId('doc-status')).toHaveTextContent('No PDF yet');
    unmount();

    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar({ updatedAt: null, staleness: 'unknown' });
    expect(screen.getByTestId('doc-status')).toHaveTextContent('PDF saved');
  });

  it('always rebuilds on send, even with an "up to date" file', async () => {
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar({ updatedAt: null, staleness: 'unknown', send: sendProp() });

    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(screen.getByTestId('composer-send'));

    // A file exists, so the version/overwrite prompt still stands between the
    // send and the stored document (spec §2).
    await screen.findByText('Replace the existing PDF?');
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));

    await waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect(build).toHaveBeenCalled();
    expect(sendFn.mock.calls[0][0]).toBe('new-file');
  });
});

  it('Escape during the version dialog closes only the dialog, not the composer', async () => {
    h.state.file = FILE;
    h.state.upToDate = false;
    renderBar({ send: sendProp() });

    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(screen.getByTestId('composer-send'));
    await screen.findByText('Replace the existing PDF?');

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByText('Replace the existing PDF?')).toBeNull());
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(sendFn).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalledWith('Failed to send', expect.anything());
  });

// The editors still build their prefill the way they always have (comma
// separated strings, a plain-text body). The bar is what turns that into what
// the mail composer speaks, so nobody had to teach seven editors about Addr[].
describe('DocumentActionsBar — composer wiring', () => {
  it('converts the editor prefill into the composer\u2019s structured initial', () => {
    h.accounts = [{ id: 'a1', emailAddress: 'me@bigbear.test' }];
    renderBar({
      send: sendProp({
        composer: {
          title: 'Send invoice',
          defaultTo: 'client@example.com, "Ann" <ann@example.com>',
          defaultCc: 'cc@example.com',
          defaultBcc: 'bcc@example.com',
          defaultSubject: 'Invoice 12',
          defaultBody: 'Hello,\n\nAttached & signed.',
        },
      }),
    });
    fireEvent.click(screen.getByTestId('doc-send'));

    const props = h.composerProps.last;
    expect(props.variant).toBe('modal');
    expect(props.title).toBe('Send invoice');
    expect(props.accounts).toEqual(h.accounts);
    expect(props.initial.to).toEqual([{ addr: 'client@example.com' }, { addr: 'ann@example.com', name: 'Ann' }]);
    expect(props.initial.cc).toEqual([{ addr: 'cc@example.com' }]);
    expect(props.initial.bcc).toEqual([{ addr: 'bcc@example.com' }]);
    expect(props.initial.subject).toBe('Invoice 12');
    // Escaped and line-broken, matching the server's own textToHtml.
    expect(props.initial.html).toBe('<p>Hello,<br><br>Attached &amp; signed.</p>');
  });

  it('describes the generated document as the primary attachment', () => {
    renderBar({ send: sendProp() });
    fireEvent.click(screen.getByTestId('doc-send'));
    expect(h.composerProps.last.primaryAttachment).toEqual({
      name: 'Invoice-12.pdf', itemType: 'invoice', itemId: 'inv-1',
    });
  });

  // Replying into a thread the user's own mailbox does not hold would 404 at
  // the server, so the option is offered only when it can actually be taken.
  it('offers the existing thread only when this user owns it', () => {
    const { unmount } = renderBar({ send: sendProp() });
    fireEvent.click(screen.getByTestId('doc-send'));
    expect(h.composerProps.last.existingThread).toBeUndefined();
    unmount();

    h.threads.newest = LINK;
    h.threads.myThread = { accountId: 'a1', threadKey: 'tk-1', subject: 'Invoice 12' };
    renderBar({ send: sendProp() });
    fireEvent.click(screen.getByTestId('doc-send'));
    expect(h.composerProps.last.existingThread).toEqual({ accountId: 'a1', threadKey: 'tk-1', subject: 'Invoice 12' });
  });

  it('hands the composer\u2019s request to sendFn and returns its result', async () => {
    const req = { ...SEND_REQUEST, to: [{ addr: 'someone@else.com' }], replyTo: { accountId: 'a1', threadKey: 'tk-1' } };
    h.sendReq = req;
    const result = { success: true, messageId: 'm1', threadKey: 'tk-1', accountId: 'a1', effectsSkipped: [] };
    sendFn.mockResolvedValueOnce(result as any);
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar({ send: sendProp() });

    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(sendFn).toHaveBeenCalledWith('f1', req));
    // The composer needs the result back: it is what carries `effectsSkipped`.
    await expect(sendFn.mock.results[0].value).resolves.toBe(result);
    // A send creates the thread link the chip reads, so it has to be re-read.
    expect(h.threads.reload).toHaveBeenCalled();
  });

  it('does not reload the thread links when the send failed', async () => {
    sendFn.mockRejectedValueOnce(new Error('SMTP asleep'));
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar({ send: sendProp() });

    fireEvent.click(screen.getByTestId('doc-send'));
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(h.sendErrors).toHaveLength(1));
    expect(h.threads.reload).not.toHaveBeenCalled();
  });

  it('shows the sent-thread chip once the item has been emailed', () => {
    const { unmount } = renderBar({ send: sendProp() });
    expect(screen.queryByTestId('doc-sent-thread')).toBeNull();
    unmount();

    h.accounts = [{ id: 'a1', emailAddress: 'me@bigbear.test' }];
    h.threads.links = [LINK];
    h.threads.newest = LINK;
    h.threads.myThread = { accountId: 'a1', threadKey: 'tk-1', subject: 'Invoice 12' };
    renderBar({ send: sendProp() });
    expect(screen.getByTestId('doc-sent-thread')).toHaveAttribute('href', '/mail/a1/_/tk-1');
  });

  // The chip is about the record, not about the Send button: a read-only or
  // unsendable editor still has to show that the thing went out.
  it('shows the chip even when the bar has no send configured', () => {
    h.accounts = [{ id: 'a1', emailAddress: 'me@bigbear.test' }];
    h.threads.links = [LINK];
    h.threads.newest = LINK;
    h.threads.myThread = null;
    renderBar({ readOnly: true });
    expect(screen.getByTestId('doc-sent-thread')).toHaveTextContent('by another user');
  });

  // Until the mailbox list has landed there is no basis for saying the thread
  // belongs to someone else — the earlier version of this flashed that claim.
  it('makes no ownership claim while the mailbox list is still loading', () => {
    h.accountsLoading = true;
    h.threads.links = [LINK];
    h.threads.newest = LINK;
    h.threads.myThread = null;
    renderBar({ send: sendProp() });
    expect(screen.getByTestId('doc-sent-thread')).not.toHaveTextContent('by another user');
  });

  // …but a user with no mailbox at all has a final answer, and must not be
  // parked on "Looking for the conversation…" forever.
  it('makes the claim once the list has landed empty', () => {
    h.accountsLoading = false;
    h.accounts = [];
    h.threads.links = [LINK];
    h.threads.newest = LINK;
    h.threads.myThread = null;
    renderBar({ send: sendProp() });
    expect(screen.getByTestId('doc-sent-thread')).toHaveTextContent('by another user');
  });
});

describe('DocumentActionsBar — open / download / formats', () => {
  it('downloads the stored file', async () => {
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar();
    fireEvent.click(screen.getByTestId('doc-download'));
    await waitFor(() => expect(fetchFileBlob).toHaveBeenCalledWith('f1'));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Invoice-12.pdf'));
  });

  it('opens the viewer straight from the file it already holds', async () => {
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar();
    fireEvent.click(screen.getByTestId('doc-open'));
    // The by-source lookup already returned name/mime/size/version, so the
    // shared viewer hook opens without a second metadata round trip.
    expect(await screen.findByTestId('viewer')).toHaveTextContent('Invoice-12.pdf');
    expect(getFileMeta).not.toHaveBeenCalled();
  });

  it('labels the chip for the xlsx format', () => {
    const { unmount } = renderBar({ format: 'xlsx' });
    expect(screen.getByTestId('doc-status')).toHaveTextContent('No Excel yet');
    unmount();

    h.state.file = FILE;
    h.state.upToDate = true;
    const second = renderBar({ format: 'xlsx' });
    expect(screen.getByTestId('doc-status')).toHaveTextContent('Excel up to date');
    second.unmount();

    h.state.upToDate = false;
    renderBar({ format: 'xlsx' });
    expect(screen.getByTestId('doc-status')).toHaveTextContent('Excel out of date');
  });

  it('renders only Open and Download when read-only', () => {
    h.state.file = FILE;
    h.state.upToDate = true;
    renderBar({ readOnly: true, send: sendProp() });
    expect(screen.getByTestId('doc-open')).toBeInTheDocument();
    expect(screen.getByTestId('doc-download')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-generate')).toBeNull();
    expect(screen.queryByTestId('doc-send')).toBeNull();
  });

  it('words the version dialog for the xlsx format', async () => {
    h.state.file = { ...FILE, name: 'PayApp-3.xlsx' };
    h.state.upToDate = true;
    renderBar({ format: 'xlsx', fileName: 'PayApp-3.xlsx' });
    fireEvent.click(screen.getByTestId('doc-generate'));
    await screen.findByText('Replace the existing Excel file?');
  });

  it('blocks Generate and Send until the record has an id', () => {
    renderBar({ source: { sourceType: 'invoice', sourceId: undefined }, send: sendProp() });
    const gen = screen.getByTestId('doc-generate');
    expect(gen).toBeDisabled();
    expect(gen).toHaveAttribute('title', 'Save first');
    const snd = screen.getByTestId('doc-send');
    expect(snd).toBeDisabled();
    expect(snd).toHaveAttribute('title', 'Save first');
  });

  // The bytes are already stored by the time onGenerated runs, so a failure in
  // the editor's own bookkeeping must not be reported as a failed generation —
  // that would send the user off regenerating a document that exists.
  it('reports an onGenerated failure as a linking failure, not a generation failure', async () => {
    onGenerated.mockRejectedValueOnce(new Error('setProposalFile blew up'));
    renderBar();

    fireEvent.click(screen.getByTestId('doc-generate'));

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(
      'PDF generated, but linking it to the record failed', { type: 'warning' },
    ));
    expect(h.toast).not.toHaveBeenCalledWith('Failed to generate the PDF', expect.anything());
    expect(persistGeneratedDocument).toHaveBeenCalled();
    // The file is real, so the bar still refreshes into its Open/Download state.
    expect(h.state.refresh).toHaveBeenCalled();
  });

  it('honours a custom testIdPrefix', () => {
    renderBar({ testIdPrefix: 'aia' });
    expect(screen.getByTestId('aia-status')).toBeInTheDocument();
    expect(screen.getByTestId('aia-generate')).toBeInTheDocument();
  });
});
