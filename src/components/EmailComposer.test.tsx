// src/components/EmailComposer.test.tsx
// Focused on the send outcome paths — in particular that a mid-send
// DocumentGenerationCancelled (the caller backed out of DocumentActionsBar's
// version/overwrite prompt) is NOT reported as a failed send.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EmailComposer } from './EmailComposer';
import { DocumentGenerationCancelled } from './documents/errors';

const h = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('./Toast', () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()),
  uploadProjectFile: vi.fn(async () => ({ fileId: 'att-1', versioned: false })),
}));

const onSend = vi.fn(async (_msg: { to: string; subject: string; body: string }) => {});
const onClose = vi.fn();

const renderComposer = () =>
  render(
    <EmailComposer
      open
      onClose={onClose}
      projectId="p1"
      primaryAttachmentName="Invoice-12.pdf"
      defaultTo="client@example.com"
      defaultSubject="Invoice 12"
      defaultBody="Attached."
      onSend={onSend}
    />
  );

const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send' }));

beforeEach(() => { vi.clearAllMocks(); onSend.mockResolvedValue(undefined); });

describe('EmailComposer send outcomes', () => {
  it('sends the seeded message and closes', async () => {
    renderComposer();
    send();
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0][0]).toMatchObject({
      to: 'client@example.com', subject: 'Invoice 12', body: 'Attached.',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('reports a real send failure and stays open', async () => {
    onSend.mockRejectedValue(new Error('smtp down'));
    renderComposer();
    send();
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Failed to send', { type: 'error' }));
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
  });

  it('stays open silently when the caller cancels document generation', async () => {
    onSend.mockRejectedValue(new DocumentGenerationCancelled());
    renderComposer();
    send();
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    expect(h.toast).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The typed message survives for a retry.
    expect(screen.getByDisplayValue('Invoice 12')).toBeInTheDocument();
  });
});
