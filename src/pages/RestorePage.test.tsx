import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/ConfirmDialog';

const h = vi.hoisted(() => ({
  getSetupState: vi.fn(async () => ({ fresh: true })),
  // The restart poll uses the strict read, which throws while the server is
  // down instead of reporting a swallowed error as "not fresh".
  getSetupStateStrict: vi.fn(async () => ({ fresh: true })),
  getRestoreSources: vi.fn(async () => ({ root: '/bk', local: [{ id: '20260912-020000', createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, counts: { files: 3, bytes: 900 }, warnings: 0 }], drive: { configurable: false, connected: false, email: null } })),
  uploadRestoreZip: vi.fn(), getRestoreDriveSnapshots: vi.fn(async () => []), restoreSnapshot: vi.fn(async () => ({ restarting: true, files: 3, bytes: 900 })),
}));
vi.mock('../utils/store', async (orig) => ({ ...(await orig<typeof import('../utils/store')>()), ...h }));
import { RestorePage } from './RestorePage';

const mount = () => render(<MemoryRouter><ToastProvider><ConfirmProvider><RestorePage /></ConfirmProvider></ToastProvider></MemoryRouter>);
// clearAllMocks only clears recorded calls — an implementation set with
// mockResolvedValue in one test would otherwise leak into the next, so the
// defaults ("fresh install", "server still answering fresh") are re-armed here.
beforeEach(() => { vi.clearAllMocks(); h.getSetupState.mockResolvedValue({ fresh: true }); h.getSetupStateStrict.mockResolvedValue({ fresh: true }); localStorage.setItem('token', 't'); localStorage.setItem('user', JSON.stringify({ id: 'admin-id-123', username: 'admin', role: 'admin' })); });

// A test that fails before its own useRealTimers() would otherwise leave fake
// timers armed for the next one, turning one failure into several.
afterEach(() => { vi.useRealTimers(); });

/** Pick the one local snapshot and confirm, leaving the page in `restarting`. */
const pickAndConfirm = async () => {
  fireEvent.click(await screen.findByTestId('restore-snapshot-20260912-020000'));
  fireEvent.click(screen.getByTestId('restore-confirm'));
  fireEvent.click(await screen.findByRole('button', { name: /^restore$/i })); // confirm dialog
  await waitFor(() => expect(h.restoreSnapshot).toHaveBeenCalled());
  expect(await screen.findByTestId('restore-progress')).toHaveTextContent(/restarting/i);
};

describe('RestorePage', () => {
  it('lists local snapshots, shows a summary on pick, and after confirm polls until the server is back then routes to login', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.getSetupStateStrict.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ fresh: false });
    mount();
    fireEvent.click(await screen.findByTestId('restore-snapshot-20260912-020000'));
    expect(screen.getByText(/3 files/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('restore-confirm'));
    fireEvent.click(await screen.findByRole('button', { name: /^restore$/i })); // confirm dialog
    await waitFor(() => expect(h.restoreSnapshot).toHaveBeenCalledWith({ source: 'local', snapshotId: '20260912-020000' }));
    expect(await screen.findByTestId('restore-progress')).toHaveTextContent(/restarting/i);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restored/i));
    // The fresh-install admin's session does not exist on the restored server.
    expect(localStorage.getItem('token')).toBeNull();
    vi.useRealTimers();
  });

  it('keeps waiting while the server answers that it is still fresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.getSetupStateStrict.mockResolvedValueOnce({ fresh: true }).mockResolvedValueOnce({ fresh: true }).mockResolvedValueOnce({ fresh: false });
    mount();
    await pickAndConfirm();
    // Two answers in, the database has not been swapped yet — still restarting.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restarting/i);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restored/i));
    vi.useRealTimers();
  });

  it('gives up after five minutes of a server that never comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.getSetupStateStrict.mockRejectedValue(new Error('down'));
    mount();
    await pickAndConfirm();
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60 * 1000); });
    expect(screen.getByTestId('restore-progress')).toHaveTextContent(/restarting/i);
    await act(async () => { await vi.advanceTimersByTimeAsync(90 * 1000); });
    await waitFor(() => expect(screen.getByTestId('restore-progress')).toHaveTextContent(/has not come back/i));
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
