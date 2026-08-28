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
    rows: [{ id: 'f-pick', name: 'site.jpg', mime: 'image/jpeg', size: 1024, kind: 'other', createdAt: 0, versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Test', customerId: null, customerName: null, source: null }],
    total: 1,
  })),
  getProjectsSummary: vi.fn(async () => []),
  getCustomers: vi.fn(async () => []),
  getDocumentTypes: vi.fn(async () => []),
}));
import { addProposalPhoto, removeProposalPhoto } from '../../../utils/store';
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
});
