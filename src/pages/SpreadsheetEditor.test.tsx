// src/pages/SpreadsheetEditor.test.tsx
//
// "Open" has only ever meant the local disk. A workbook already filed under
// Documents now opens by reference through the shared picker — and because
// the ?fileId= entry point only runs once on mount, picking has to call the
// open-by-id routine directly rather than push a new query string
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';

const h = vi.hoisted(() => ({ pickers: new Map<string, any>() }));

vi.mock('../components/documents/AddFilesButton', () => ({
  AddFilesButton: (props: any) => {
    h.pickers.set(props.label, props);
    return <button data-testid={`picker-${props.label}`}>{props.label}</button>;
  },
}));
vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => ({
    socket: null, sessions: [], mySessionId: 'me',
    joinSheet: vi.fn(), sendSheetOp: vi.fn(), sendSheetState: vi.fn(),
    requestSheetSnapshot: vi.fn(), sendSheetPresence: vi.fn(),
    onSheetEvent: () => () => {},
  }),
}));
vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()),
  getFileMeta: vi.fn(async () => ({ id: 'doc-1', name: 'Budget.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', projectId: 'p1' })),
  fetchFileBlob: vi.fn(async () => new Blob(['sheet'])),
}));
import { getFileMeta, fetchFileBlob } from '../utils/store';
import { SpreadsheetEditor } from './SpreadsheetEditor';

const mount = () => render(
  <MemoryRouter>
    <ToastProvider><SpreadsheetEditor /></ToastProvider>
  </MemoryRouter>
);

beforeEach(() => { h.pickers.clear(); vi.clearAllMocks(); });

describe('SpreadsheetEditor — open from documents', () => {
  it('offers a single-pick spreadsheet picker beside Open', async () => {
    await act(async () => { mount(); });
    const props = h.pickers.get('Open from documents');
    expect(props).toBeTruthy();
    expect(props.accept).toBe('spreadsheet');
    expect(props.multi).toBe(false);
    // Rows, not bytes — opening by id is what wires the tab to its collab session.
    expect(props.returnBlobs).toBeFalsy();
    expect(screen.getByTestId('picker-Open from documents')).toBeInTheDocument();
  });

  it('picking a row opens that file by id', async () => {
    await act(async () => { mount(); });
    const props = h.pickers.get('Open from documents');
    await act(async () => { await props.onPick([{ id: 'doc-1', name: 'Budget.xlsx' }]); });
    await waitFor(() => expect(getFileMeta).toHaveBeenCalledWith('doc-1'));
    expect(fetchFileBlob).toHaveBeenCalledWith('doc-1');
  });
});
