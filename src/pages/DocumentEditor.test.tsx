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

const h = vi.hoisted(() => ({
  openInEditor: vi.fn(), loadDocsApi: vi.fn(), theme: 'light' as 'light' | 'dark',
  getEditorHistory: vi.fn(), getEditorHistoryData: vi.fn(), restoreFileVersion: vi.fn(),
}));
vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()),
  openInEditor: h.openInEditor,
  getEditorHistory: h.getEditorHistory,
  getEditorHistoryData: h.getEditorHistoryData,
  restoreFileVersion: h.restoreFileVersion,
}));
vi.mock('../utils/onlyofficeApi', () => ({ loadDocsApi: h.loadDocsApi }));
vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ mode: h.theme }) }));
import { EditorOpenError, RestoreError, getRecentDocuments } from '../utils/store';
import { DocumentEditor } from './DocumentEditor';

const opening = (over: Record<string, unknown> = {}) => ({
  publicUrl: 'https://docs.example.com',
  config: { documentType: 'word', document: { key: 'f1-v1-abc', title: 'Scope.docx' }, token: 'signed' },
  file: { id: 'f1', name: 'Scope.docx', projectId: 'p1', kind: 'document', ext: 'docx', mode: 'edit', editable: true },
  ...over,
});

let constructed: { placeholderId: string; config: any; instance: any }[];
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
      constructed.push({ placeholderId, config, instance: this });
      this.destroyEditor = () => { destroyed++; };
      this.refreshHistory = vi.fn();
      this.setHistoryData = vi.fn();
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

describe('DocumentEditor — version history', () => {
  const HISTORY = {
    currentVersion: 2,
    versions: [
      { version: 1, key: 'k1', createdAt: Date.UTC(2026, 8, 25, 9), user: { id: 'u1', name: 'nathan' }, origin: null },
      { version: 2, key: 'k2', createdAt: Date.UTC(2026, 8, 26, 9), user: { id: 'u2', name: 'crew' }, origin: 'editor', changes: [{ created: 'x' }], serverVersion: '9.4.0' },
    ],
  };
  const events = async () => {
    await waitFor(() => expect(constructed).toHaveLength(1));
    return constructed[0].config.events;
  };

  beforeEach(() => {
    h.getEditorHistory.mockResolvedValue(HISTORY);
    h.getEditorHistoryData.mockResolvedValue({ version: 1, key: 'k1', url: 'http://app/file', fileType: 'docx', token: 't' });
    h.restoreFileVersion.mockResolvedValue({ versionNumber: 3, restoredFrom: 1 });
  });

  it('lists the versions the server knows, with authors and change logs', async () => {
    mount();
    await (await events()).onRequestHistory();
    const arg = constructed[0].instance.refreshHistory.mock.calls[0][0];
    expect(arg.currentVersion).toBe(2);
    expect(arg.history).toHaveLength(2);
    expect(arg.history[0]).toMatchObject({ version: 1, key: 'k1', user: { id: 'u1', name: 'nathan' } });
    expect(typeof arg.history[0].created).toBe('string');
    expect(arg.history[0].changes).toBeUndefined();
    expect(arg.history[1]).toMatchObject({ version: 2, changes: [{ created: 'x' }], serverVersion: '9.4.0' });
  });

  it('shows the history as an error when it cannot be loaded', async () => {
    h.getEditorHistory.mockRejectedValue(new Error('Server down'));
    mount();
    await (await events()).onRequestHistory();
    expect(constructed[0].instance.refreshHistory).toHaveBeenCalledWith({ error: 'Server down' });
  });

  it('hands ONLYOFFICE the signed data for the version picked', async () => {
    mount();
    const ev = await events();
    await ev.onRequestHistoryData({ data: 1 });
    expect(h.getEditorHistoryData).toHaveBeenCalledWith('f1', 1);
    expect(constructed[0].instance.setHistoryData).toHaveBeenCalledWith(expect.objectContaining({ version: 1, token: 't' }));

    h.getEditorHistoryData.mockRejectedValue(new Error('That version no longer exists.'));
    await ev.onRequestHistoryData({ data: 7 });
    expect(constructed[0].instance.setHistoryData).toHaveBeenLastCalledWith({ version: 7, error: 'That version no longer exists.' });
  });

  it('starts the editor again when the history closes', async () => {
    mount();
    (await events()).onRequestHistoryClose();
    await waitFor(() => expect(constructed).toHaveLength(2));
    expect(destroyed).toBe(1);
    expect(h.openInEditor).toHaveBeenCalledTimes(2);
  });

  it('restores from inside the editor as a new version, then shows the new list', async () => {
    mount();
    await (await events()).onRequestRestore({ data: { version: 1 } });
    expect(h.restoreFileVersion).toHaveBeenCalledWith('f1', { version: 1 }, 'editor');
    expect(await screen.findByText('Version 1 restored as version 3')).toBeInTheDocument();
    expect(constructed[0].instance.refreshHistory).toHaveBeenCalled();
  });

  it('says why a restore has to wait, and keeps the history usable', async () => {
    h.restoreFileVersion.mockRejectedValue(new RestoreError('crew is editing this file. Restore once the editor is closed.', 409, 'open-in-editor', ['crew']));
    mount();
    await (await events()).onRequestRestore({ data: { version: 1 } });
    expect(await screen.findByText(/crew is editing this file/)).toBeInTheDocument();
    expect(constructed[0].instance.refreshHistory).toHaveBeenCalled();
  });

  it('offers no Restore where the file only opens for viewing', async () => {
    h.openInEditor.mockResolvedValue(opening({ file: { ...opening().file, mode: 'view' } }));
    mount();
    const ev = await events();
    expect(ev.onRequestRestore).toBeUndefined();
    expect(typeof ev.onRequestHistory).toBe('function');
  });
});
