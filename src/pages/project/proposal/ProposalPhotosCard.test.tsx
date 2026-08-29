import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/Toast';
import type { Proposal } from '../../../utils/store';

vi.mock('../../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../../utils/store')>()),
  addProposalPhoto: vi.fn(async () => {}),
  updateProposalPhoto: vi.fn(async () => {}),
  removeProposalPhoto: vi.fn(async () => {}),
  uploadProjectFile: vi.fn(async () => ({ fileId: 'f-new', versioned: false })),
  getDocuments: vi.fn(async () => ({
    rows: [
      { id: 'f-pick', name: 'site.jpg', mime: 'image/jpeg', size: 1024, kind: 'other', createdAt: 0, versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Test', customerId: null, customerName: null, source: null },
      { id: 'f-pick2', name: 'site2.jpg', mime: 'image/jpeg', size: 2048, kind: 'other', createdAt: 0, versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Test', customerId: null, customerName: null, source: null },
    ],
    total: 2,
  })),
  getProjectsSummary: vi.fn(async () => []),
  getCustomers: vi.fn(async () => []),
  getDocumentTypes: vi.fn(async () => []),
}));
import { addProposalPhoto, removeProposalPhoto, updateProposalPhoto, ProposalLockedError } from '../../../utils/store';
import { ProposalPhotosCard } from './ProposalPhotosCard';

const proposal = {
  id: 'pr1', projectId: 'p1',
  photos: [
    { id: 'ph1', fileId: 'f1', sortOrder: 0, caption: 'Front porch' },
    { id: 'ph2', fileId: 'f2', sortOrder: 1, caption: null },
  ],
} as unknown as Proposal;

const renderCard = (readOnly = false, onChanged = vi.fn()) => {
  const utils = render(
    <ToastProvider>
      <ProposalPhotosCard proposal={proposal} projectId="p1" readOnly={readOnly} onChanged={onChanged} />
    </ToastProvider>
  );
  return { onChanged, ...utils };
};

beforeEach(() => { vi.clearAllMocks(); });

describe('ProposalPhotosCard', () => {
  it('renders photos from props with captions', () => {
    const { container } = renderCard();
    // Thumbnails use alt="" (decorative) so they carry no accessible "img"
    // role — query the elements directly instead.
    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(screen.getByDisplayValue('Front porch')).toBeInTheDocument();
  });

  it('hides the toolbar when read-only', () => {
    renderCard(true);
    expect(screen.queryByRole('button', { name: /Upload photos/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Choose existing/i })).toBeNull();
  });

  it('remove calls the mocked API and reloads', async () => {
    const { onChanged } = renderCard();
    fireEvent.click(screen.getAllByLabelText('Remove photo')[0]);
    await waitFor(() => expect(removeProposalPhoto).toHaveBeenCalledWith('pr1', 'f1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('"Choose existing" opens the picker and picking calls add per row', async () => {
    const { onChanged } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Choose existing/i }));
    const checkbox = await screen.findByLabelText('site.jpg');
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/i }));
    await waitFor(() => expect(addProposalPhoto).toHaveBeenCalledWith('pr1', 'f-pick'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('"Choose existing": a partial add failure toasts a warning but still resyncs', async () => {
    const { onChanged } = renderCard();
    vi.mocked(addProposalPhoto)
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => { throw new Error('nope'); });
    fireEvent.click(screen.getByRole('button', { name: /Choose existing/i }));
    fireEvent.click(await screen.findByLabelText('site.jpg'));
    fireEvent.click(screen.getByLabelText('site2.jpg'));
    fireEvent.click(screen.getByRole('button', { name: /Add 2 files/i }));
    await screen.findByText('Added 1 of 2 photos');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('caption commit PATCHes on the proposal id, not the photo row id', async () => {
    const { onChanged } = renderCard();
    const input = screen.getByDisplayValue('Front porch');
    fireEvent.change(input, { target: { value: 'Back porch' } });
    fireEvent.blur(input);
    await waitFor(() => expect(updateProposalPhoto).toHaveBeenCalledWith('pr1', 'f1', { caption: 'Back porch' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reorder: swaps sortOrder via two PATCHes on the proposal id', async () => {
    const { onChanged } = renderCard();
    fireEvent.click(screen.getAllByLabelText('Move right')[0]);
    await waitFor(() => expect(updateProposalPhoto).toHaveBeenCalledTimes(2));
    // First arg is the PROPOSAL id, not the photo row id — the API route is
    // /api/proposals/:id/photos/:fileId, so passing the row id 404s.
    expect(vi.mocked(updateProposalPhoto).mock.calls[0]).toEqual(['pr1', 'f1', { sortOrder: 1 }]);
    expect(vi.mocked(updateProposalPhoto).mock.calls[1]).toEqual(['pr1', 'f2', { sortOrder: 0 }]);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reorder: if the second PATCH fails, toasts and still resyncs via onChanged', async () => {
    const { onChanged } = renderCard();
    vi.mocked(updateProposalPhoto)
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => { throw new Error('boom'); });
    fireEvent.click(screen.getAllByLabelText('Move right')[0]);
    await screen.findByText('Failed to reorder photos');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('remove: a locked proposal toasts a warning and still reloads into read-only', async () => {
    const { onChanged } = renderCard();
    vi.mocked(removeProposalPhoto).mockRejectedValueOnce(new ProposalLockedError());
    fireEvent.click(screen.getAllByLabelText('Remove photo')[0]);
    await screen.findByText('This proposal was sent and is now locked');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
