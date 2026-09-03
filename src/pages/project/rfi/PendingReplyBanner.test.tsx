// src/pages/project/rfi/PendingReplyBanner.test.tsx
//
// The banner is the review step between "an email came back on this RFI" and
// "this is the recorded response". Everything it shows — sender name, body
// text, attachment names — is a string an outsider typed into an email, so the
// rendering tests below are as much about the trust boundary as the layout.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Rfi, RfiPendingReply } from '../../../utils/store';

const h = vi.hoisted(() => ({
  dismissRfiPendingReply: vi.fn(),
  setRfiResponse: vi.fn(),
  saveProps: { last: null as any },
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  dismissRfiPendingReply: h.dismissRfiPendingReply,
  setRfiResponse: h.setRfiResponse,
}));

// Stand-in for the mail-side save modal: records the props it was handed and
// lets a test fire its onSaved callback with the file ids the server made.
vi.mock('../../mail/SaveAttachmentsModal', () => ({
  SaveAttachmentsModal: (props: any) => {
    h.saveProps.last = props;
    return props.open ? (
      <div data-testid="save-attachments">
        <button data-testid="save-attachments-done" onClick={() => props.onSaved?.(['file-77'])}>saved</button>
      </div>
    ) : null;
  },
}));

import { ToastProvider } from '../../../components/Toast';
import { ConfirmProvider } from '../../../components/ConfirmDialog';
import { PendingReplyBanner } from './PendingReplyBanner';

const pending = (over: Partial<RfiPendingReply> = {}): RfiPendingReply => ({
  threadKey: 'thr-1', accountId: 'acct-1', mailMessageId: 'msg-1', messageIdHeader: 'm1@teg.com',
  from: { addr: 'gc@teg.com', name: 'Mike Ruiz' },
  date: '2026-08-28T10:00:00.000Z',
  text: 'Corridor is 9\'-0" per the reflected ceiling plan.',
  attachments: [], receivedAt: '2026-08-28T10:00:05.000Z',
  ...over,
});

const rfi = (over: Partial<Rfi> = {}): Rfi => ({
  id: 'rfi-1', projectId: 'p1', number: 4, title: 'Header detail',
  question: 'Which detail governs?', specRef: null, drawingRef: null,
  attention: null, responseNeededBy: null, responseText: null, responseFileId: null,
  status: 'sent', version: 2, sentAt: 5, answeredAt: null,
  createdAt: 1, updatedAt: 10, photos: [], pendingReply: pending(),
  ...over,
});

const cb = { onUseAsResponse: vi.fn(), onDismissed: vi.fn(), onOpenThread: vi.fn(), onResponseFile: vi.fn() };

const mount = (r: Rfi = rfi(), canOpenThread = true) =>
  render(
    <ToastProvider>
      <ConfirmProvider>
        <PendingReplyBanner
          rfi={r}
          projectId="p1"
          canOpenThread={canOpenThread}
          onUseAsResponse={cb.onUseAsResponse}
          onDismissed={cb.onDismissed}
          onOpenThread={cb.onOpenThread}
          onResponseFile={cb.onResponseFile}
        />
      </ConfirmProvider>
    </ToastProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.saveProps.last = null;
  h.dismissRfiPendingReply.mockResolvedValue(undefined);
  h.setRfiResponse.mockResolvedValue(undefined);
});

describe('PendingReplyBanner', () => {
  it('renders the sender, the date and the reply text', () => {
    mount();
    expect(screen.getByTestId('rfi-pending-reply')).toBeInTheDocument();
    expect(screen.getByText(/Mike Ruiz/)).toBeInTheDocument();
    expect(screen.getByTestId('rfi-pending-reply-text')).toHaveTextContent(
      'Corridor is 9\'-0" per the reflected ceiling plan.'
    );
  });

  it('falls back to the address when the sender has no display name', () => {
    mount(rfi({ pendingReply: pending({ from: { addr: 'gc@teg.com' } }) }));
    expect(screen.getByText(/gc@teg\.com/)).toBeInTheDocument();
  });

  // The RFI's status is the authority on whether an answer is still awaited: a
  // pendingReply row can outlive an out-of-band status change (someone closed
  // the RFI by hand), and reviewing a reply on a closed RFI is nonsense.
  it('renders nothing unless the RFI is still awaiting a reply', () => {
    mount(rfi({ status: 'closed' }));
    expect(screen.queryByTestId('rfi-pending-reply')).toBeNull();
  });

  it('renders nothing when there is no pending reply', () => {
    mount(rfi({ pendingReply: null }));
    expect(screen.queryByTestId('rfi-pending-reply')).toBeNull();
  });

  // Trust boundary: sender name, body and attachment names are attacker-chosen
  // strings from an inbound email. They must reach the DOM as text — never as
  // markup — so the literal characters survive and no element is created.
  it('renders hostile sender/body/attachment strings as text, not markup', () => {
    const evil = '<img src=x onerror="alert(1)">';
    mount(rfi({
      pendingReply: pending({
        from: { addr: 'gc@teg.com', name: evil },
        text: `answer ${evil}`,
        attachments: [{ attId: 'a1', name: `${evil}.pdf`, mime: 'application/pdf', size: 10 }],
      }),
    }));
    const banner = screen.getByTestId('rfi-pending-reply');
    expect(banner.textContent).toContain(evil);            // the literal characters survived
    expect(banner.querySelector('img')).toBeNull();         // and made no element
    expect(banner.innerHTML).toContain('&lt;img src=x');    // escaped, not markup
  });

  it('collapses a long reply behind Show more', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    mount(rfi({ pendingReply: pending({ text: long }) }));
    const body = screen.getByTestId('rfi-pending-reply-text');
    expect(body.className).toContain('line-clamp-6');

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByTestId('rfi-pending-reply-text').className).not.toContain('line-clamp-6');
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('offers no Show more for a short reply', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('Use as response hands the reply text back to the editor', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Use as response' }));
    expect(cb.onUseAsResponse).toHaveBeenCalledWith('Corridor is 9\'-0" per the reflected ceiling plan.');
    // Nothing is saved from here — the editor's own Save is the commit point.
    expect(h.setRfiResponse).not.toHaveBeenCalled();
  });

  it('Dismiss drops the pending reply and tells the editor to refresh', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(h.dismissRfiPendingReply).toHaveBeenCalledWith('rfi-1'));
    await waitFor(() => expect(cb.onDismissed).toHaveBeenCalled());
  });

  // Someone else accepted or dismissed the same reply first. The banner is
  // stale, so refresh rather than leaving a dead card on screen.
  it('still refreshes when the reply is already gone server-side', async () => {
    const gone = new Error('No pending reply to dismiss');
    gone.name = 'NoPendingReplyError';
    h.dismissRfiPendingReply.mockRejectedValue(gone);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(cb.onDismissed).toHaveBeenCalled());
  });

  // A dropped request is not the same thing: the reply is still pending, so the
  // banner has to stay put and say the dismiss failed.
  it('keeps the banner when the dismiss request itself fails', async () => {
    h.dismissRfiPendingReply.mockRejectedValue(new Error('network down'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('Failed to dismiss the reply')).toBeInTheDocument();
    expect(cb.onDismissed).not.toHaveBeenCalled();
    expect(screen.getByTestId('rfi-pending-reply')).toBeInTheDocument();
  });

  it('opens the thread when the current user owns the mailbox', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(cb.onOpenThread).toHaveBeenCalled();
  });

  // The reply landed in the mailbox of whoever sent the RFI. For anyone else
  // the mail routes answer 403/404, so the button must not be armed — and the
  // banner has to say why instead of just going quiet.
  it('degrades to a muted note when the mailbox belongs to another user', () => {
    mount(rfi(), false);
    expect(screen.getByRole('button', { name: 'Open thread' })).toBeDisabled();
    expect(screen.getByTestId('rfi-pending-reply-foreign')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(cb.onOpenThread).not.toHaveBeenCalled();
  });

  describe('attachments', () => {
    const withAtt = () => rfi({
      pendingReply: pending({
        attachments: [{ attId: 'a1', name: 'ceiling-detail.pdf', mime: 'application/pdf', size: 2048 }],
      }),
    });

    it('lists attachment names and hands the message id to the save modal', () => {
      mount(withAtt());
      expect(screen.getByText('ceiling-detail.pdf')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Save to Documents/i }));
      expect(h.saveProps.last).toMatchObject({
        open: true, messageId: 'msg-1', defaultProjectId: 'p1',
        attachments: [expect.objectContaining({ attId: 'a1', name: 'ceiling-detail.pdf' })],
      });
    });

    it('offers the saved file as the response document, on confirmation', async () => {
      mount(withAtt());
      fireEvent.click(screen.getByRole('button', { name: /Save to Documents/i }));
      fireEvent.click(screen.getByTestId('save-attachments-done'));

      // The prompt names the file, and that name is attacker-chosen text —
      // matching it as text proves it stayed text.
      expect(await screen.findByText(/Use ceiling-detail\.pdf as the RFI response document/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Use it' }));

      await waitFor(() => expect(h.setRfiResponse).toHaveBeenCalledWith('rfi-1', { fileId: 'file-77' }));
      await waitFor(() => expect(cb.onResponseFile).toHaveBeenCalled());
    });

    it('leaves the response alone when the confirmation is declined', async () => {
      mount(withAtt());
      fireEvent.click(screen.getByRole('button', { name: /Save to Documents/i }));
      fireEvent.click(screen.getByTestId('save-attachments-done'));

      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(h.setRfiResponse).not.toHaveBeenCalled());
    });
  });
});
