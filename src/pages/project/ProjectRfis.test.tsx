// src/pages/project/ProjectRfis.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({
  getRfis: vi.fn(),
  getRfi: vi.fn(),
  getDocumentsBySource: vi.fn(),
}));

vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRfis: h.getRfis, getRfi: h.getRfi, getDocumentsBySource: h.getDocumentsBySource,
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
}));
vi.mock('./ProjectLayout', () => ({
  useProjectOutlet: () => ({ summary: { name: 'P1', contractor: '' } }),
}));
vi.mock('../documents/DocumentViewerModal', () => ({
  DocumentViewerModal: ({ row, onClose }: any) => (
    <div data-testid="viewer">
      <span>{row.name}</span>
      <button onClick={onClose}>close viewer</button>
    </div>
  ),
}));

// A stand-in editor that reports every mount: the list must not re-key it when
// the editor saves itself, or the document bar inside it would be torn down
// mid-flow.
const mounts = { count: 0 };
vi.mock('./rfi/RfiEditor', () => ({
  RfiEditor: ({ onSaved }: any) => {
    React.useEffect(() => { mounts.count += 1; }, []);
    return (
      <div data-testid="editor">
        <button data-testid="save-kept" onClick={() => onSaved({ keepMounted: true })}>save kept</button>
        <button data-testid="save-plain" onClick={() => onSaved()}>save plain</button>
      </div>
    );
  },
}));

import { ProjectRfis, rfiNo, isRfiOverdue } from './ProjectRfis';

describe('rfiNo', () => {
  it('pads to three digits', () => {
    expect(rfiNo(1)).toBe('RFI-001');
    expect(rfiNo(42)).toBe('RFI-042');
    expect(rfiNo(1234)).toBe('RFI-1234');
  });
});

describe('isRfiOverdue', () => {
  const now = new Date('2026-07-28T12:00:00');
  it('true when past due and not answered/closed', () => {
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'sent' }, now)).toBe(true);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'open' }, now)).toBe(true);
  });
  it('false when answered, closed, not due yet, or dateless', () => {
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'answered' }, now)).toBe(false);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-27', status: 'closed' }, now)).toBe(false);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-29', status: 'sent' }, now)).toBe(false);
    expect(isRfiOverdue({ responseNeededBy: '2026-07-28', status: 'sent' }, now)).toBe(false); // due today ≠ overdue
    expect(isRfiOverdue({ responseNeededBy: null, status: 'sent' }, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Document status on rows + editor remounting (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md)

const listRow = (over: Record<string, any> = {}) => ({
  id: 'r1', projectId: 'p1', number: 1, title: 'Header detail', question: null,
  specRef: null, drawingRef: null, attention: null, responseNeededBy: null,
  responseText: null, responseFileId: null, status: 'open', version: 1,
  sentAt: null, answeredAt: null, createdAt: 1, updatedAt: 10, photoCount: 0,
  ...over,
});

const FILE = { id: 'f1', name: 'RFI-001.pdf', mime: 'application/pdf', size: 12, createdAt: 50, versionNumber: 1 };

const mount = () =>
  render(
    <MemoryRouter initialEntries={['/project/p1/rfis']}>
      <Routes><Route path="/project/:projectId/rfis" element={<ProjectRfis />} /></Routes>
    </MemoryRouter>
  );

describe('ProjectRfis — PDF status on rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getRfis.mockResolvedValue([listRow(), listRow({ id: 'r2', number: 2, title: 'Lintel size' })]);
    h.getDocumentsBySource.mockResolvedValue({ r1: FILE, r2: null });
    h.getRfi.mockResolvedValue(null);
  });

  it('shows a chip and an Open button only for the RFI that has a PDF', async () => {
    mount();
    await screen.findByText('Header detail');
    await waitFor(() => expect(h.getDocumentsBySource).toHaveBeenCalled());
    expect(h.getDocumentsBySource.mock.calls[0][0]).toMatchObject({
      sourceType: 'rfi', kind: 'rfi', sourceIds: ['r1', 'r2'],
    });

    await waitFor(() => expect(screen.getByText('PDF up to date')).toBeInTheDocument());
    expect(screen.queryByText('No PDF yet')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open PDF' })).toHaveLength(1);
  });

  it('marks the chip out of date when the RFI changed after the PDF was made', async () => {
    h.getDocumentsBySource.mockResolvedValue({ r1: { ...FILE, createdAt: 5 }, r2: null });
    mount();
    await waitFor(() => expect(screen.getByText('PDF out of date')).toBeInTheDocument());
  });

  it('opens the viewer instead of the editor when Open is clicked', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open PDF' }));

    expect(await screen.findByTestId('viewer')).toBeInTheDocument();
    expect(screen.getByText('RFI-001.pdf')).toBeInTheDocument();
    expect(h.getRfi).not.toHaveBeenCalled();
  });

  it('keeps the editor mounted for its own saves and re-keys it for outside refreshes', async () => {
    h.getRfi.mockResolvedValue({ ...listRow(), photos: [] });
    mounts.count = 0;
    mount();

    fireEvent.click(await screen.findByText('Header detail'));
    await screen.findByTestId('editor');
    await waitFor(() => expect(mounts.count).toBe(1));

    // act() flushes the reload's promises and the resulting render, so a
    // remount would already have happened by the time we count.
    await act(async () => { fireEvent.click(screen.getByTestId('save-kept')); });
    expect(h.getRfi).toHaveBeenCalledTimes(2); // open + reload
    expect(mounts.count).toBe(1);

    // A refresh that found nothing new must not throw away a typed draft.
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(1);

    // A record that actually moved on does re-key the editor.
    h.getRfi.mockResolvedValue({ ...listRow({ version: 2 }), photos: [] });
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(2);
  });
});
