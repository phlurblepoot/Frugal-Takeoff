import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ConfirmProvider } from '../../../components/ConfirmDialog';
import { ToastProvider } from '../../../components/Toast';
import type { FileUploadOpts, ProposalSaveInput } from '../../../utils/store';
import type { BuildProposalPdfArgs } from './buildProposalPdf';

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
const getProposal = vi.fn(async () => proposal);
const getProject = vi.fn(async (_id: string) => ({
  id: 'proj1', name: 'Test', pages: [], takeoffs: [], planSets: [],
  contactEmails: { estimating: { to: 'client@example.com' } },
}));
const persistGeneratedDocument = vi.fn(async (_blob: Blob, _opts: FileUploadOpts & { kind: string; name: string }) => ({ fileId: 'f-generated', versioned: false }));
const setProposalFile = vi.fn(async (_id: string, _fileId: string) => {});
const sendProposal = vi.fn(async (_id: string, _payload: { to: string; fileId: string; attachmentFileIds?: string[] }) => ({ version: 5 }));

vi.mock('../../../utils/store', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/store')>('../../../utils/store');
  return {
    ...actual,
    getProposal,
    getProject,
    getUserPreferences: vi.fn(async () => ({ 'proposal-manualLine-history': JSON.stringify([{ description: 'Permit', amountCents: 25000 }]) })),
    saveProposal,
    saveUserPreferences,
    persistGeneratedDocument,
    setProposalFile,
    sendProposal,
    getSettings: vi.fn(async () => ({ companyEmail: 'office@bigbear.test' })),
    getSmtpSettings: vi.fn(async () => ({ fromAddress: 'me@bigbear.test' })),
    getAlwaysCc: vi.fn(async () => ''),
    getCustomer: vi.fn(async () => undefined),
  };
});

// The renderer itself is exercised by proposalGenerator.layout.test.ts; here
// only the pipeline around it matters.
const buildProposalPdf = vi.fn(async (_args: BuildProposalPdfArgs) => ({
  pdfBytes: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
  suggestedName: 'Proposal – Test – 2026-08-28',
  overBudget: false,
  sections: {},
}));
vi.mock('./buildProposalPdf', () => ({ buildProposalPdf }));

// Imported dynamically, not statically: a static import is evaluated before
// this file's `const proposal` runs, and the store mock's factory closes over
// it. Awaiting the import here means the fixture is initialised first.
const { ProposalEditor } = await import('./ProposalEditor');

const { ProposalLockedError } = await import('../../../utils/store');

const renderEditor = () => render(
  <ToastProvider>
    <ConfirmProvider>
      <MemoryRouter initialEntries={['/project/proj1/proposal/p1']}>
        <Routes><Route path="/project/:projectId/proposal/:proposalId" element={<ProposalEditor />} /></Routes>
      </MemoryRouter>
    </ConfirmProvider>
  </ToastProvider>,
);

describe('ProposalEditor smoke', () => {
  beforeEach(() => {
    localStorage.setItem('user', JSON.stringify({ role: 'admin' }));
    saveProposal.mockClear();
    getProject.mockClear();
    getProposal.mockClear();
    buildProposalPdf.mockClear();
    persistGeneratedDocument.mockClear();
    setProposalFile.mockClear();
    sendProposal.mockClear();
  });

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

  it('does not flag every takeoff line as missing when the project fetch fails', async () => {
    const takeoffLine = {
      id: 'l2', sortOrder: 1, kind: 'takeoff', takeoffId: 't1', description: 'Stucco',
      amountCents: 500000, derivedAmountCents: 500000, measurementSummary: '5,000.00 sq ft', isAlternate: false,
    };
    proposal.lines.push(takeoffLine as (typeof proposal)['lines'][number]);
    getProject.mockRejectedValueOnce(new Error('offline'));
    try {
      render(
        <ToastProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={['/project/proj1/proposal/p1']}>
              <Routes><Route path="/project/:projectId/proposal/:proposalId" element={<ProposalEditor />} /></Routes>
            </MemoryRouter>
          </ConfirmProvider>
        </ToastProvider>,
      );
      expect(await screen.findByText('#2')).toBeInTheDocument();
      expect(screen.queryByText(/no longer exists/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Remove line/ })).not.toBeInTheDocument();
      expect(await screen.findByText(/amounts not refreshed/i)).toBeInTheDocument();
      // Nothing was re-derived, so there is nothing to save.
      expect(screen.getByTestId('proposal-state')).toHaveTextContent('Saved');
    } finally {
      proposal.lines.pop();
    }
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

  it('Generate saves the draft first, then stores the PDF as the proposal document', async () => {
    renderEditor();
    await screen.findByText('#2');
    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'Ready to print' } });

    fireEvent.click(screen.getByTestId('btn-generate-proposal'));
    await waitFor(() => expect(setProposalFile).toHaveBeenCalledWith('p1', 'f-generated'));

    // Save-first is the whole contract: the client receives exactly what was
    // stored, never a PDF of edits that failed to save.
    expect(saveProposal.mock.invocationCallOrder[0])
      .toBeLessThan(buildProposalPdf.mock.invocationCallOrder[0]);
    const rendered = buildProposalPdf.mock.calls[0][0];
    expect(rendered.proposal.coverNotes).toBe('Ready to print');
    expect(rendered.includeHighlights).toBe(false);
    expect(rendered.headerEmail).toBeUndefined();
    expect(persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'proj1', kind: 'proposal', name: 'Proposal – Test – 2026-08-28',
      sourceType: 'proposal', sourceId: 'p1',
    });
    expect(await screen.findByText('Proposal PDF generated')).toBeInTheDocument();
    // Reloaded, so the new fileId (and with it the Send button) appears.
    await waitFor(() => expect(getProposal).toHaveBeenCalledTimes(2));
  });

  it('Generate says so rather than doing nothing while a save is still in flight', async () => {
    let release = () => {};
    saveProposal.mockImplementationOnce(
      () => new Promise(resolve => { release = () => resolve({ version: 4 }); }));
    renderEditor();
    await screen.findByText('#2');
    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'in flight' } });
    fireEvent.click(screen.getByTestId('btn-save-proposal'));
    await waitFor(() => expect(screen.getByTestId('btn-save-proposal')).toHaveTextContent('Saving…'));

    fireEvent.click(screen.getByTestId('btn-generate-proposal'));
    expect(await screen.findByText(/Save in progress/)).toBeInTheDocument();
    expect(buildProposalPdf).not.toHaveBeenCalled();
    await act(async () => { release(); });
  });

  it('a save that bounces off a lock aborts the generate', async () => {
    saveProposal.mockRejectedValueOnce(new ProposalLockedError());
    renderEditor();
    await screen.findByText('#2');
    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'Too late' } });

    fireEvent.click(screen.getByTestId('btn-generate-proposal'));
    await waitFor(() => expect(saveProposal).toHaveBeenCalled());
    expect(await screen.findByText(/no longer a draft/)).toBeInTheDocument();
    expect(buildProposalPdf).not.toHaveBeenCalled();
    expect(setProposalFile).not.toHaveBeenCalled();
  });

  it('Send needs no prior Generate, but is blocked while the draft is unsaved', async () => {
    renderEditor();
    await screen.findByText('#2');
    // Send renders its own PDF, so a proposal with no fileId is still sendable.
    expect(proposal.fileId).toBeNull();
    expect(screen.getByTestId('btn-send-proposal')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Cover notes'), { target: { value: 'edited' } });
    expect(screen.getByTestId('btn-send-proposal')).toBeDisabled();
    expect(screen.getByTestId('btn-send-proposal')).toHaveAttribute('title', 'Save first');
  });

  const openComposer = async () => {
    renderEditor();
    await screen.findByText('#2');
    fireEvent.click(screen.getByTestId('btn-send-proposal'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText('To')).toHaveValue('client@example.com'));
    return dialog;
  };

  it('always renders and stores a fresh PDF before sending it', async () => {
    // A stored fileId goes stale the moment anything is saved or a photo
    // changes, so the send never trusts one — it renders its own.
    proposal.fileId = 'f-stale' as (typeof proposal)['fileId'];
    try {
      const dialog = await openComposer();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(sendProposal).toHaveBeenCalled());
      expect(buildProposalPdf).toHaveBeenCalledTimes(1);
      expect(persistGeneratedDocument).toHaveBeenCalledTimes(1);
      expect(setProposalFile).toHaveBeenCalledWith('p1', 'f-generated');
      expect(buildProposalPdf.mock.invocationCallOrder[0])
        .toBeLessThan(sendProposal.mock.invocationCallOrder[0]);
      expect(persistGeneratedDocument.mock.invocationCallOrder[0])
        .toBeLessThan(sendProposal.mock.invocationCallOrder[0]);
      // The fresh document goes out — never the stale one on the record.
      expect(sendProposal.mock.calls[0]).toMatchObject(['p1', {
        to: 'client@example.com', fileId: 'f-generated', attachmentFileIds: [],
      }]);
      expect(await screen.findByText('Proposal sent')).toBeInTheDocument();
    } finally {
      proposal.fileId = null;
    }
  });

  it('stamps the from-address the sender picked onto that PDF', async () => {
    const dialog = await openComposer();
    fireEvent.change(within(dialog).getByLabelText('Document shows email:'), { target: { value: 'me@bigbear.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendProposal).toHaveBeenCalled());
    expect(buildProposalPdf.mock.calls[0][0]).toMatchObject({ headerEmail: 'me@bigbear.test' });
    expect(sendProposal.mock.calls[0][1]).toMatchObject({ fileId: 'f-generated' });
  });

  it('a render that fails aborts the send instead of emailing the old PDF', async () => {
    proposal.fileId = 'f-stale' as (typeof proposal)['fileId'];
    buildProposalPdf.mockRejectedValueOnce(new Error('render blew up'));
    try {
      const dialog = await openComposer();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

      expect(await screen.findByText(/Could not generate the proposal PDF/)).toBeInTheDocument();
      expect(sendProposal).not.toHaveBeenCalled();
      // The composer stays open so the send can be retried.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    } finally {
      proposal.fileId = null;
    }
  });

  it('blocks Send when the draft has no price lines, same message as Generate', async () => {
    const savedLines = proposal.lines;
    proposal.lines = [];
    try {
      renderEditor();
      await screen.findByText('#2');
      expect(screen.getByTestId('btn-send-proposal')).toBeDisabled();
      expect(screen.getByTestId('btn-send-proposal')).toHaveAttribute('title', 'Add at least one price line');
    } finally {
      proposal.lines = savedLines;
    }
  });

  it('disables Generate while a send is rendering its own PDF, re-enabling once it settles', async () => {
    let release = () => {};
    buildProposalPdf.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({
        pdfBytes: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
        suggestedName: 'Proposal – Test – 2026-08-28', overBudget: false, sections: {},
      });
    }));
    const dialog = await openComposer();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByTestId('btn-generate-proposal')).toBeDisabled());
    await act(async () => { release(); });
    await waitFor(() => expect(sendProposal).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('btn-generate-proposal')).toBeEnabled());
  });
});
