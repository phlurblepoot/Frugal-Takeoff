// src/pages/project/daily/DailyReportEditor.test.tsx
//
// The editor no longer owns document delivery: DocumentActionsBar does
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
// What stays the editor's job — and is what these tests pin — is handing the
// bar a `build()` that reads the SAVED report (photos included), never the
// typed-in draft.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DailyReport } from '../../../utils/store';

const h = vi.hoisted(() => ({
  getDailyReport: vi.fn(),
  saveDailyReport: vi.fn(),
  sendDailyReport: vi.fn(),
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildDailyReportPdf: vi.fn(),
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getDailyReport: h.getDailyReport,
  saveDailyReport: h.saveDailyReport,
  sendDailyReport: h.sendDailyReport,
  persistGeneratedDocument: h.persistGeneratedDocument,
  getDocumentBySource: h.getDocumentBySource,
  getDocumentsBySource: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
  getSmtpSettings: vi.fn(async () => ({})),
  getAlwaysCc: vi.fn(async () => ''),
  getProject: vi.fn(async () => null),
  getCustomer: vi.fn(async () => undefined),
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
  getFileMeta: vi.fn(async () => null),
  getImageUrl: (id: string) => `/img/${id}`,
}));

vi.mock('./dailyReportPdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dailyReportPdf')>()),
  buildDailyReportPdf: h.buildDailyReportPdf,
}));

vi.mock('../../../pages/documents/DocumentViewerModal', () => ({
  DocumentViewerModal: () => <div data-testid="viewer" />,
}));

vi.mock('../../../components/EmailComposer', () => ({
  EmailComposer: ({ open, onSend, onClose }: any) =>
    open ? (
      <div data-testid="composer">
        <button
          data-testid="composer-send"
          onClick={() => {
            void onSend({ to: 'gc@example.com', subject: 's', body: 'b', attachmentFileIds: [] })
              .then(() => onClose())
              .catch(() => {});
          }}
        >
          send
        </button>
      </div>
    ) : null,
}));

import { ToastProvider } from '../../../components/Toast';
import { DailyReportEditor } from './DailyReportEditor';

const report = (over: Partial<DailyReport> = {}): DailyReport => ({
  id: 'dr-1', projectId: 'p1', reportDate: '2026-08-26', jobName: 'Big Job',
  contractorName: 'GC Inc', weatherSummary: 'Sunny', temperature: '78F',
  weatherHourly: [{ hour: '9am', tempF: 78, condition: 'Sunny' }],
  manCounts: [{ type: 'Plasterer', count: 3 }], fieldNotes: 'All quiet', issues: '',
  // version 2 (not 1) so the mount effect doesn't auto-fetch weather.
  createdBy: null, createdAt: 1, updatedAt: 10, version: 2, photos: [],
  ...over,
});

// What the server hands back after the save — deliberately different from the
// prop so "built from saved state" is falsifiable.
const SAVED = report({ jobName: 'SERVER JOB', version: 3, updatedAt: 20, photos: [{ id: 'ph-1', fileId: 'f-photo', sortOrder: 0 }] });

const onSaved = vi.fn();

const tree = (r: DailyReport) => (
  <MemoryRouter>
    <ToastProvider>
      <DailyReportEditor
        report={r}
        projectId="p1"
        projectName="Big Job"
        contractor="GC Inc"
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    </ToastProvider>
  </MemoryRouter>
);

const mount = (r: DailyReport = report()) => render(tree(r));

beforeEach(() => {
  vi.clearAllMocks();
  h.getDailyReport.mockResolvedValue(SAVED);
  h.saveDailyReport.mockResolvedValue({ version: 3 });
  h.sendDailyReport.mockResolvedValue(undefined);
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-9', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildDailyReportPdf.mockReturnValue(new Uint8Array([1, 2, 3]).buffer);
});

describe('DailyReportEditor — document actions', () => {
  it('mounts the shared bar and drops its own Download PDF / Send… buttons', async () => {
    mount();
    expect(await screen.findByTestId('doc-generate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send…/i })).toBeNull();
    // Close/Save stay the editor's own.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('saves the draft first, then builds the PDF from the report the server now holds', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Job name'), { target: { value: 'Typed job' } });

    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.saveDailyReport).toHaveBeenCalledTimes(1));
    expect(h.saveDailyReport.mock.calls[0][1]).toMatchObject({ jobName: 'Typed job' });

    await waitFor(() => expect(h.buildDailyReportPdf).toHaveBeenCalledTimes(1));
    // Not the prop and not the local draft — the saved record, photos and all.
    expect(h.buildDailyReportPdf.mock.calls[0][0].report).toBe(SAVED);
    expect(h.buildDailyReportPdf.mock.calls[0][0].photoDataUrls).toHaveLength(1);

    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(h.persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'p1', kind: 'daily-report', sourceType: 'dailyReport', sourceId: 'dr-1',
    });
    // The parent refreshes without re-keying the editor, so the bar survives
    // its own save-then-generate flow.
    expect(onSaved).toHaveBeenCalledWith({ keepMounted: true });
  });

  it('reports a failed re-read instead of storing pre-save bytes', async () => {
    h.getDailyReport.mockRejectedValue(new Error('offline'));
    mount();

    fireEvent.click(await screen.findByTestId('doc-generate'));

    expect(await screen.findByText('Failed to generate the PDF')).toBeInTheDocument();
    expect(h.buildDailyReportPdf).not.toHaveBeenCalled();
    expect(h.persistGeneratedDocument).not.toHaveBeenCalled();
  });

  it('stops blocking Email once the saved record comes back', async () => {
    const { rerender } = mount();
    expect(await screen.findByTestId('doc-send')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Job name'), { target: { value: 'Typed job' } });
    expect(screen.getByTestId('doc-send')).toHaveAttribute('title', 'Save first');

    rerender(tree(report({ jobName: 'Typed job', version: 3, updatedAt: 20 })));

    const send = screen.getByTestId('doc-send');
    expect(send).toBeEnabled();
    expect(send).not.toHaveAttribute('title', 'Save first');
  });

  it('sends the generated file through sendDailyReport', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendDailyReport).toHaveBeenCalledTimes(1));
    expect(h.sendDailyReport.mock.calls[0][0]).toBe('dr-1');
    expect(h.sendDailyReport.mock.calls[0][1]).toMatchObject({ to: 'gc@example.com', fileId: 'file-9' });
  });
});
