import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ConfirmProvider } from '../../../components/ConfirmDialog';
import type { ProposalSaveInput } from '../../../utils/store';

const proposal = {
  id: 'p1', projectId: 'proj1', number: 2, revisedFromId: null, revisedFromNumber: null,
  status: 'draft', legacy: false, title: 'Stucco package', validUntil: null,
  fontFamily: 'helvetica', coverNotes: 'Hello', terms: 'Net 30',
  inclusions: ['Scaffolding'], exclusions: ['Paint'], paymentSchedule: null,
  showGrandTotal: true, includeCostDetail: false, includeSignature: true, highlightQuality: 'best',
  fileId: null, signedFileId: null, sentAt: null, sentTo: null, acceptedAt: null, declinedAt: null,
  version: 3, createdBy: null, createdAt: 0, updatedAt: 0,
  totalCents: 1000000, alternateCount: 0, hasOverride: false, photoCount: 0, attachmentCount: 0,
  lines: [{ id: 'l1', sortOrder: 0, kind: 'manual', takeoffId: null, description: 'Mobilization', amountCents: 1000000, derivedAmountCents: null, measurementSummary: null, isAlternate: false }],
  photos: [], attachments: [],
};

const saveProposal = vi.fn(async (_id: string, _input: ProposalSaveInput) => ({ version: 4 }));
const saveUserPreferences = vi.fn(async (_prefs: Record<string, string>) => {});

vi.mock('../../../utils/store', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/store')>('../../../utils/store');
  return {
    ...actual,
    getProposal: vi.fn(async () => proposal),
    getProject: vi.fn(async () => ({ id: 'proj1', name: 'Test', pages: [], takeoffs: [], planSets: [] })),
    getUserPreferences: vi.fn(async () => ({ 'proposal-manualLine-history': JSON.stringify([{ description: 'Permit', amountCents: 25000 }]) })),
    saveProposal,
    saveUserPreferences,
  };
});

// Imported dynamically, not statically: a static import is evaluated before
// this file's `const proposal` runs, and the store mock's factory closes over
// it. Awaiting the import here means the fixture is initialised first.
const { ProposalEditor } = await import('./ProposalEditor');

const renderEditor = () => render(
  <ConfirmProvider>
    <MemoryRouter initialEntries={['/project/proj1/proposal/p1']}>
      <Routes><Route path="/project/:projectId/proposal/:proposalId" element={<ProposalEditor />} /></Routes>
    </MemoryRouter>
  </ConfirmProvider>,
);

describe('ProposalEditor smoke', () => {
  beforeEach(() => { localStorage.setItem('user', JSON.stringify({ role: 'admin' })); saveProposal.mockClear(); });

  it('mounts, edits, and saves', async () => {
    renderEditor();
    expect(await screen.findByText('#2')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-state')).toHaveTextContent('Saved');
    expect(screen.getByTestId('pricing-total')).toHaveTextContent('$10,000.00');
    // library select from prefs
    expect(await screen.findByLabelText('From library')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'New notes' } });
    expect(screen.getByTestId('proposal-state')).toHaveTextContent('Unsaved changes');
    fireEvent.click(screen.getByTestId('btn-save-proposal'));
    await waitFor(() => expect(saveProposal).toHaveBeenCalled());
    expect(saveProposal.mock.calls[0][1]).toMatchObject({
      version: 3, coverNotes: 'New notes', inclusions: ['Scaffolding'], exclusions: ['Paint'],
      lines: [{ kind: 'manual', description: 'Mobilization', amountCents: 1000000 }],
    });
    await waitFor(() => expect(screen.getByTestId('proposal-state')).toHaveTextContent('Saved'));
    await waitFor(() => expect(saveUserPreferences).toHaveBeenCalled());
    expect(saveUserPreferences.mock.calls[0][0]).toMatchObject({
      'proposal-coverNotes-history': JSON.stringify(['New notes']),
      'proposal-manualLine-history': JSON.stringify([{ description: 'Mobilization', amountCents: 1000000 }, { description: 'Permit', amountCents: 25000 }]),
      'proposal-showGrandTotal': 'true',
    });
    // no takeoff lines => no highlights option
    expect(screen.queryByLabelText('Attach highlighted plan pages')).not.toBeInTheDocument();
  });

  it('payment schedule toggles and inclusions edit', async () => {
    renderEditor();
    await screen.findByText('#2');
    fireEvent.click(screen.getByLabelText('Include payment schedule'));
    fireEvent.click(screen.getByRole('button', { name: /Add row/ }));
    expect(screen.getByTestId('schedule-total')).toHaveTextContent('$10,000.00');
    fireEvent.change(screen.getByLabelText('Percent'), { target: { value: '40' } });
    expect(screen.getByTestId('schedule-total')).toHaveTextContent('$4,000.00');
    expect(screen.getByText(/not 100%/)).toBeInTheDocument();

    const inc = screen.getByTestId('proposal-inclusions');
    fireEvent.change(inc, { target: { value: 'Scaffolding\n' } });
    expect((inc as HTMLTextAreaElement).value).toBe('Scaffolding\n');
  });
});
