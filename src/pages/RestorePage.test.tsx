import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/ConfirmDialog';

const h = vi.hoisted(() => ({
  getSetupState: vi.fn(async () => ({ fresh: true })),
  getRestoreSources: vi.fn(async () => ({ root: '/bk', local: [{ id: '20260912-020000', createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, counts: { files: 3, bytes: 900 }, warnings: 0 }], drive: { configurable: false, connected: false, email: null } })),
  uploadRestoreZip: vi.fn(), getRestoreDriveSnapshots: vi.fn(async () => []), restoreSnapshot: vi.fn(async () => ({ restarting: true, files: 3, bytes: 900 })),
}));
vi.mock('../utils/store', async (orig) => ({ ...(await orig<typeof import('../utils/store')>()), ...h }));
import { RestorePage } from './RestorePage';

const mount = () => render(<MemoryRouter><ToastProvider><ConfirmProvider><RestorePage /></ConfirmProvider></ToastProvider></MemoryRouter>);
// clearAllMocks only clears recorded calls — an implementation set with
// mockResolvedValue in one test would otherwise leak into the next, so the
// default "fresh install" answer is re-armed here.
beforeEach(() => { vi.clearAllMocks(); h.getSetupState.mockResolvedValue({ fresh: true }); localStorage.setItem('token', 't'); localStorage.setItem('user', JSON.stringify({ id: 'admin-id-123', username: 'admin', role: 'admin' })); });

describe('RestorePage', () => {
  it('lists local snapshots, shows a summary on pick, and after confirm polls until the server is back then routes to login', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.getSetupState.mockResolvedValueOnce({ fresh: true }).mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ fresh: false });
    mount();
    fireEvent.click(await screen.findByTestId('restore-snapshot-20260912-020000'));
    expect(screen.getByText(/3 files/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('restore-confirm'));
    fireEvent.click(await screen.findByRole('button', { name: /^restore$/i })); // confirm dialog
    await waitFor(() => expect(h.restoreSnapshot).toHaveBeenCalledWith({ source: 'local', snapshotId: '20260912-020000' }));
    expect(await screen.findByTestId('restore-progress')).toHaveTextContent(/restarting/i);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restored/i));
    vi.useRealTimers();
  });

  it('refuses to render when the install is not fresh', async () => {
    h.getSetupState.mockResolvedValue({ fresh: false });
    mount();
    expect(await screen.findByText(/already has data/i)).toBeInTheDocument();
  });

  it('upload source shows progress and the uploaded summary', async () => {
    h.uploadRestoreZip.mockImplementation(async (_f: File, onP: (n: number) => void) => { onP(50); return { uploadId: 'u1', snapshotId: '20260901-000000', summary: { id: '20260901-000000', createdAt: 1, appVersion: '3.1.0', schemaVersion: 35, counts: { files: 7, bytes: 1 }, warnings: 1 } }; });
    mount();
    fireEvent.click(await screen.findByTestId('restore-source-upload'));
    const input = screen.getByTestId('restore-upload-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['zip'], 's.zip')] } });
    expect(await screen.findByText(/7 files/)).toBeInTheDocument();
    expect(screen.getByText(/1 warning/)).toBeInTheDocument();
  });
});
