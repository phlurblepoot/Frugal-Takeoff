// src/pages/DocumentEditor.test.tsx
//
// The page hosts ONLYOFFICE; the server decides the config. So these tests
// check the page's own jobs: pass the server's signed config through to
// DocsAPI untouched (plus the close event), tear the editor down on leave,
// ask for the viewer on phones, and turn each way opening can fail into
// something a person can act on. A fake DocsAPI stands in for api.js.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';

const h = vi.hoisted(() => ({ openInEditor: vi.fn(), loadDocsApi: vi.fn(), theme: 'light' as 'light' | 'dark' }));
vi.mock('../utils/store', async (orig) => ({ ...(await orig<typeof import('../utils/store')>()), openInEditor: h.openInEditor }));
vi.mock('../utils/onlyofficeApi', () => ({ loadDocsApi: h.loadDocsApi }));
vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ mode: h.theme }) }));
import { EditorOpenError, getRecentDocuments } from '../utils/store';
import { DocumentEditor } from './DocumentEditor';

const opening = (over: Record<string, unknown> = {}) => ({
  publicUrl: 'https://docs.example.com',
  config: { documentType: 'word', document: { key: 'f1-v1-abc', title: 'Scope.docx' }, token: 'signed' },
  file: { id: 'f1', name: 'Scope.docx', projectId: 'p1', kind: 'document', ext: 'docx', mode: 'edit', editable: true },
  ...over,
});

let constructed: { placeholderId: string; config: any }[];
let destroyed: number;

const mount = (url = '/tools/edit?fileId=f1') => render(
  <ToastProvider>
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/tools/edit" element={<DocumentEditor />} />
        <Route path="/documents" element={<div>Documents page</div>} />
        <Route path="/settings" element={<div>Settings page</div>} />
      </Routes>
    </MemoryRouter>
  </ToastProvider>,
);

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('user', JSON.stringify({ id: 'u1', username: 'nathan', role: 'admin' }));
  h.theme = 'light';
  constructed = [];
  destroyed = 0;
  h.loadDocsApi.mockResolvedValue(undefined);
  h.openInEditor.mockResolvedValue(opening());
  window.DocsAPI = {
    DocEditor: function DocEditor(this: any, placeholderId: string, config: any) {
      constructed.push({ placeholderId, config });
      this.destroyEditor = () => { destroyed++; };
    } as any,
  };
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  delete window.DocsAPI;
});

describe('DocumentEditor — a file', () => {
  it('mounts ONLYOFFICE with the server config, from the public address, and remembers the file', async () => {
    h.theme = 'dark';
    mount();
    await waitFor(() => expect(constructed).toHaveLength(1));
    expect(h.openInEditor).toHaveBeenCalledWith('f1', { device: 'desktop', theme: 'dark' });
    expect(h.loadDocsApi).toHaveBeenCalledWith('https://docs.example.com');
    const { placeholderId, config } = constructed[0];
    expect(config).toMatchObject({ documentType: 'word', token: 'signed', document: { key: 'f1-v1-abc' } });
    expect(typeof config.events.onRequestClose).toBe('function');
    // The placeholder is a plain node inside the host, for ONLYOFFICE to replace.
    expect(screen.getByTestId('document-editor-host').querySelector(`#${placeholderId}`)).not.toBeNull();
    expect(screen.queryByTestId('document-editor-loading')).toBeNull();
    expect(getRecentDocuments()[0]).toMatchObject({ id: 'f1', name: 'Scope.docx' });
  });

  it('tears the editor down when leaving the page', async () => {
    const view = mount();
    await waitFor(() => expect(constructed).toHaveLength(1));
    view.unmount();
    expect(destroyed).toBe(1);
  });

  it('asks for the phone viewer on small screens', async () => {
    window.matchMedia = ((query: string) => ({ ...originalMatchMedia(query), matches: query.includes('max-width') })) as any;
    mount();
    await waitFor(() => expect(h.openInEditor).toHaveBeenCalledWith('f1', { device: 'phone', theme: 'light' }));
  });

  it("goes back when the editor's own Close button is pressed", async () => {
    mount();
    await waitFor(() => expect(constructed).toHaveLength(1));
    constructed[0].config.events.onRequestClose();
    expect(await screen.findByText('Documents page')).toBeInTheDocument();
  });

  it('explains a setup problem and points an admin at Settings, with a download fallback', async () => {
    h.openInEditor.mockRejectedValue(new EditorOpenError("The document editor isn't set up yet.", 503, 'not-configured'));
    mount();
    expect(await screen.findByText(/isn't set up yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Settings → Document Editor/ })).toHaveAttribute('href', '/settings?tab=document-editor');
    expect(screen.getByRole('button', { name: /Download instead/ })).toBeInTheDocument();
    expect(constructed).toHaveLength(0);
  });

  it('tells a regular user to ask an admin', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u2', role: 'user' }));
    h.openInEditor.mockRejectedValue(new EditorOpenError('Couldn\'t reach ONLYOFFICE.', 503, 'onlyoffice-unreachable'));
    mount();
    expect(await screen.findByText(/Ask an admin/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Settings/ })).toBeNull();
  });

  it('says when api.js cannot be loaded from the public address', async () => {
    h.loadDocsApi.mockRejectedValue(new Error('the request failed'));
    mount();
    expect(await screen.findByText(/Couldn't load the editor from https:\/\/docs\.example\.com \(the request failed\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Settings → Document Editor/ })).toBeInTheDocument();
  });

  it('shows "File not found" for a missing file and drops it from the recent list', async () => {
    localStorage.setItem('recentDocuments', JSON.stringify([{ id: 'f1', name: 'Gone.docx', mime: '', at: 1 }]));
    h.openInEditor.mockRejectedValue(new EditorOpenError('File not found', 404));
    mount();
    expect(await screen.findByText('File not found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download instead/ })).toBeNull();
    expect(getRecentDocuments()).toEqual([]);
  });
});

describe('DocumentEditor — landing', () => {
  it('lists recently opened files, opens one, and can forget one', async () => {
    localStorage.setItem('recentDocuments', JSON.stringify([
      { id: 'a', name: 'Bid.pdf', mime: 'application/pdf', at: 2 },
      { id: 'b', name: 'SOV.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', at: 1 },
    ]));
    mount('/tools/edit');
    expect(screen.getByTestId('document-editor-landing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove SOV.xlsx from recent' }));
    expect(screen.queryByText('SOV.xlsx')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bid.pdf' }));
    await waitFor(() => expect(h.openInEditor).toHaveBeenCalledWith('a', expect.anything()));
  });

  it('offers opening from Documents and from the computer', () => {
    mount('/tools/edit');
    expect(screen.getByRole('button', { name: /Open from Documents/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open from computer/ })).toBeInTheDocument();
    expect(screen.getByText('Nothing opened yet')).toBeInTheDocument();
  });
});
