// src/pages/PdfEditor.test.tsx
//
// The editor's three "bring me a file" affordances — open, import pages,
// insert image — were all bare <input type="file">, so anything already
// filed under Documents had to be downloaded and re-uploaded first. Each now
// has a documents-picker twin beside it
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/ConfirmDialog';

const h = vi.hoisted(() => ({
  pickers: new Map<string, any>(),
  getDocument: vi.fn(() => ({ promise: Promise.resolve({ numPages: 0, destroy: async () => {} }) })),
}));

vi.mock('../components/documents/AddFilesButton', () => ({
  AddFilesButton: (props: any) => {
    h.pickers.set(props.label, props);
    return <button data-testid={`picker-${props.label}`}>{props.label}</button>;
  },
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: h.getDocument,
}));
vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()),
  getFileMeta: vi.fn(async () => ({ id: 'doc-1', name: 'Plans.pdf', mime: 'application/pdf', projectId: 'p1' })),
  fetchFileBlob: vi.fn(async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' })),
  getDraft: vi.fn(async () => null),
}));
import { getFileMeta, fetchFileBlob } from '../utils/store';
import { PdfEditor } from './PdfEditor';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'doc-1', name: 'Plans.pdf', mime: 'application/pdf', size: 10,
  kind: 'other', createdAt: 0, versionNumber: 1, archived: false,
  projectId: 'p1', projectName: 'Test', customerId: null, customerName: null, source: null,
  ...over,
});

const mount = () => render(
  <MemoryRouter>
    <ToastProvider><ConfirmProvider><PdfEditor /></ConfirmProvider></ToastProvider>
  </MemoryRouter>
);

const RealFileReader = globalThis.FileReader;

beforeEach(() => { h.pickers.clear(); vi.clearAllMocks(); });
afterEach(() => { globalThis.FileReader = RealFileReader; });

describe('PdfEditor — documents pickers', () => {
  it('offers a single-pick PDF picker beside Open', async () => {
    await act(async () => { mount(); });
    const props = h.pickers.get('Open from documents');
    expect(props).toBeTruthy();
    expect(props.accept).toBe('pdf');
    expect(props.multi).toBe(false);
    // Rows, not bytes: opening by id is what ties the tab back to the stored
    // file, so Save writes a new version instead of a local download.
    expect(props.returnBlobs).toBeFalsy();
    expect(screen.getByTestId('picker-Open from documents')).toBeInTheDocument();
  });

  it('picking a row opens that PDF by id', async () => {
    await act(async () => { mount(); });
    await act(async () => { await h.pickers.get('Open from documents').onPick([row()]); });
    await waitFor(() => expect(getFileMeta).toHaveBeenCalledWith('doc-1'));
    expect(fetchFileBlob).toHaveBeenCalledWith('doc-1');
  });

  it('imports pages from a picked document', async () => {
    await act(async () => { mount(); });
    const props = h.pickers.get('Import pages');
    expect(props.accept).toBe('any');
    expect(props.multi).toBe(false);
    expect(props.returnBlobs).toBe(true);

    await act(async () => {
      await props.onPickBlobs([{ row: row(), blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }) }]);
    });
    // The blob reached importPages as a PDF-shaped File.
    await waitFor(() => expect(h.getDocument).toHaveBeenCalled());
  });

  it('inserts an image from a picked document', async () => {
    const reads: File[] = [];
    class FakeReader {
      result: string | null = null;
      onloadend: (() => void) | null = null;
      readAsDataURL(f: File) { reads.push(f); this.result = 'data:image/png;base64,AA'; this.onloadend?.(); }
    }
    globalThis.FileReader = FakeReader as unknown as typeof FileReader;

    await act(async () => { mount(); });
    const props = h.pickers.get('Insert image');
    expect(props.accept).toBe('image');
    expect(props.multi).toBe(false);
    expect(props.returnBlobs).toBe(true);

    await act(async () => {
      await props.onPickBlobs([{ row: row({ name: 'site.png', mime: 'image/png' }), blob: new Blob(['x'], { type: 'image/png' }) }]);
    });
    expect(reads).toHaveLength(1);
    expect(reads[0].name).toBe('site.png');
    expect(reads[0].type).toBe('image/png');
  });
});
