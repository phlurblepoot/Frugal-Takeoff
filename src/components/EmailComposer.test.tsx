// src/components/EmailComposer.test.tsx
// Focused on the send outcome paths — in particular that a mid-send
// DocumentGenerationCancelled (the caller backed out of DocumentActionsBar's
// version/overwrite prompt) is NOT reported as a failed send.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EmailComposer } from './EmailComposer';
import { uploadProjectFile } from '../utils/store';
import { DocumentGenerationCancelled } from './documents/errors';

const h = vi.hoisted(() => ({ toast: vi.fn(), pickerProps: null as any }));
vi.mock('./Toast', () => ({ useToast: () => ({ toast: h.toast }) }));

// Stand-in picker button: records the config the composer asked for and hands
// back one already-uploaded row on demand.
vi.mock('./documents/AddFilesButton', () => ({
  AddFilesButton: (props: any) => {
    h.pickerProps = props;
    return (
      <button
        data-testid="attach-files"
        onClick={() => void props.onPick([{ id: 'doc-9', name: 'warranty.pdf' }])}
      >
        {props.label}
      </button>
    );
  },
}));
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

describe('EmailComposer attachments', () => {
  it('attaches through the shared picker rather than a bare file input', () => {
    const { container } = renderComposer();

    expect(screen.getByTestId('attach-files')).toBeInTheDocument();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Add attachment/i })).toBeNull();
    // Global picker (no project pre-filter) that uploads into this project.
    expect(h.pickerProps).toMatchObject({
      label: 'Attach files', accept: 'any', defaultTab: 'existing',
      upload: { kind: 'email-attachment', projectId: 'p1' },
    });
    expect(h.pickerProps.initialProjectIds).toBeUndefined();
  });

  it('a picked file becomes a removable chip and rides along on the send', async () => {
    renderComposer();
    fireEvent.click(screen.getByTestId('attach-files'));

    expect(await screen.findByText('warranty.pdf')).toBeInTheDocument();
    send();
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0][0]).toMatchObject({ attachmentFileIds: ['doc-9'] });
  });

  it('removing a chip drops it from the send', async () => {
    renderComposer();
    fireEvent.click(screen.getByTestId('attach-files'));
    fireEvent.click(await screen.findByLabelText('Remove warranty.pdf'));

    expect(screen.queryByText('warranty.pdf')).toBeNull();
    send();
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0][0]).toMatchObject({ attachmentFileIds: [] });
  });

  it('a dropped file is uploaded and attached', async () => {
    renderComposer();
    const doc = new File(['x'], 'photo.png', { type: 'image/png' });
    fireEvent.drop(screen.getByTestId('email-attachment-dropzone'), { dataTransfer: { files: [doc] } });

    await waitFor(() => expect(uploadProjectFile).toHaveBeenCalledWith('p1', doc, 'email-attachment', expect.anything()));
    expect(await screen.findByText('photo.png')).toBeInTheDocument();
  });
});

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
