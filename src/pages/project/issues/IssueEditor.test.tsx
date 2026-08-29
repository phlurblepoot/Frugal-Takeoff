// src/pages/project/issues/IssueEditor.test.tsx
//
// The editor no longer owns document delivery: DocumentActionsBar does
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
// What stays the editor's job — and is what these tests pin — is handing the
// bar a `build()` that reads the SAVED issue (photos included), never the
// typed-in draft.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Issue } from '../../../utils/store';

const h = vi.hoisted(() => ({
  getIssue: vi.fn(),
  saveIssue: vi.fn(),
  sendIssue: vi.fn(),
  persistGeneratedDocument: vi.fn(),
  getDocumentBySource: vi.fn(),
  buildIssuePdf: vi.fn(),
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getIssue: h.getIssue,
  saveIssue: h.saveIssue,
  sendIssue: h.sendIssue,
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

vi.mock('./issuePdf', () => ({ buildIssuePdf: h.buildIssuePdf }));

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
import { IssueEditor } from './IssueEditor';

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: 'iss-1', projectId: 'p1', number: 7, title: 'Cracked stucco',
  description: 'North wall', status: 'open', version: 2, sentAt: null,
  createdAt: 1, updatedAt: 10, photos: [],
  ...over,
});

// What the server hands back after the save — deliberately different from the
// prop so "built from saved state" is falsifiable.
const SAVED = issue({ title: 'SERVER TITLE', version: 3, updatedAt: 20, photos: [{ id: 'ph-1', fileId: 'f-photo', sortOrder: 0 }] });

const onSaved = vi.fn();

const tree = (iss: Issue) => (
  <MemoryRouter>
    <ToastProvider>
      <IssueEditor
        issue={iss}
        projectId="p1"
        projectName="Big Job"
        contractor="GC Inc"
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    </ToastProvider>
  </MemoryRouter>
);

const mount = (iss: Issue = issue()) => render(tree(iss));

beforeEach(() => {
  vi.clearAllMocks();
  h.getIssue.mockResolvedValue(SAVED);
  h.saveIssue.mockResolvedValue({ version: 3 });
  h.sendIssue.mockResolvedValue(undefined);
  h.persistGeneratedDocument.mockResolvedValue({ fileId: 'file-9', versioned: true });
  h.getDocumentBySource.mockResolvedValue(null);
  h.buildIssuePdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe('IssueEditor — document actions', () => {
  it('mounts the shared bar and drops its own Download PDF / Send report buttons', async () => {
    mount();
    expect(await screen.findByTestId('doc-generate')).toBeInTheDocument();
    expect(screen.getByTestId('doc-send')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send report/i })).toBeNull();
    // Close/Save stay the editor's own.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('saves the draft first, then builds the PDF from the issue the server now holds', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed title' } });

    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(h.saveIssue).toHaveBeenCalledTimes(1));
    expect(h.saveIssue.mock.calls[0][1]).toMatchObject({ title: 'Typed title' });

    await waitFor(() => expect(h.buildIssuePdf).toHaveBeenCalledTimes(1));
    // Not the prop and not the local draft — the saved record, photos and all.
    expect(h.buildIssuePdf.mock.calls[0][0].issue).toBe(SAVED);
    expect(h.buildIssuePdf.mock.calls[0][0].photoDataUrls).toHaveLength(1);

    await waitFor(() => expect(h.persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(h.persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'p1', kind: 'issue-report', name: 'ISS-007.pdf',
      sourceType: 'issue', sourceId: 'iss-1',
    });
    // The parent refreshes without re-keying the editor, so the bar survives
    // its own save-then-generate flow.
    expect(onSaved).toHaveBeenCalledWith({ keepMounted: true });
  });

  it('reports a failed re-read instead of storing pre-save bytes', async () => {
    h.getIssue.mockRejectedValue(new Error('offline'));
    mount();

    fireEvent.click(await screen.findByTestId('doc-generate'));

    expect(await screen.findByText('Failed to generate the PDF')).toBeInTheDocument();
    expect(h.buildIssuePdf).not.toHaveBeenCalled();
    expect(h.persistGeneratedDocument).not.toHaveBeenCalled();
  });

  it('stops blocking Email once the saved record comes back', async () => {
    const { rerender } = mount();
    expect(await screen.findByTestId('doc-send')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed title' } });
    expect(screen.getByTestId('doc-send')).toHaveAttribute('title', 'Save first');

    rerender(tree(issue({ title: 'Typed title', version: 3, updatedAt: 20 })));

    const send = screen.getByTestId('doc-send');
    expect(send).toBeEnabled();
    expect(send).not.toHaveAttribute('title', 'Save first');
  });

  it('sends the generated file through sendIssue', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('doc-send'));
    fireEvent.click(await screen.findByTestId('composer-send'));

    await waitFor(() => expect(h.sendIssue).toHaveBeenCalledTimes(1));
    expect(h.sendIssue.mock.calls[0][0]).toBe('iss-1');
    expect(h.sendIssue.mock.calls[0][1]).toMatchObject({ to: 'gc@example.com', fileId: 'file-9' });
  });
});
