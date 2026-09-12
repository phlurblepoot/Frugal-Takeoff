// src/pages/settings/BackupTab.test.tsx
//
// Settings → Backup is the only place an admin sees whether the nightly backup
// actually ran, so the tests cover the states that matter when it did not: the
// same-disk warning (a backup on the data volume is no backup), a failed last
// run with its error, a run already in progress, and the schedule/retention
// form round-trip.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ToastProvider } from '../../components/Toast';
import { ConfirmProvider } from '../../components/ConfirmDialog';

const h = vi.hoisted(() => ({
  getBackupStatus: vi.fn(), runBackup: vi.fn(async () => ({ runId: 'r' })), getBackupRuns: vi.fn(async () => []),
  getBackupSnapshots: vi.fn(async () => []), saveBackupSettings: vi.fn(async () => {}), disconnectBackupDrive: vi.fn(async () => {}),
}));
vi.mock('../../utils/store', async (orig) => ({ ...(await orig<typeof import('../../utils/store')>()), ...h }));
vi.mock('../../context/CollaborationContext', () => ({ useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }) }));
import { BackupTab } from './BackupTab';

const status = (over: Partial<any> = {}) => ({
  root: '/mnt/user/backups', rootIsDefault: false, lastRun: { local: null, drive: null }, running: null,
  totals: { snapshots: 0, objects: 0, bytes: 0 }, nextRunAt: null, schedule: { enabled: false, hour: 2, minute: 0 }, keep: { local: 14, drive: 14 },
  drive: { connected: false, configurable: true }, ...over,
});
const mount = () => render(<ToastProvider><ConfirmProvider><BackupTab /></ConfirmProvider></ToastProvider>);
beforeEach(() => { vi.clearAllMocks(); h.getBackupStatus.mockResolvedValue(status()); });

describe('BackupTab', () => {
  it('shows the root, the same-disk warning only when default, and Connect Google Drive when configurable', async () => {
    mount();
    expect(await screen.findByText('/mnt/user/backups')).toBeInTheDocument();
    expect(screen.queryByText(/same disk as the data/i)).toBeNull();
    expect(screen.getByRole('link', { name: /connect google drive/i })).toBeInTheDocument();
    h.getBackupStatus.mockResolvedValue(status({ rootIsDefault: true, drive: { connected: true, email: 'me@x.com', needsReconnect: false } }));
    mount();
    expect(await screen.findByText(/same disk as the data/i)).toBeInTheDocument();
    expect(screen.getByText(/connected as me@x.com/i)).toBeInTheDocument();
  });

  it('Back up now calls runBackup(local) and is disabled while a run is in progress', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^back up now$/i }));
    await waitFor(() => expect(h.runBackup).toHaveBeenCalledWith('local'));
    h.getBackupStatus.mockResolvedValue(status({ running: { id: 'r', target: 'local', trigger: 'manual', startedAt: 1, finishedAt: null, status: 'running', snapshotId: null, objectsAdded: 0, bytesWritten: 0, warnings: [], error: null } }));
    mount();
    await screen.findByText(/backing up/i);
    expect(screen.getAllByRole('button', { name: /^back up now$/i }).at(-1)).toBeDisabled();
  });

  it('shows the last error and lists snapshots with a download link', async () => {
    h.getBackupStatus.mockResolvedValue(status({ lastRun: { local: { id: 'r', target: 'local', trigger: 'schedule', startedAt: 1, finishedAt: 2, status: 'error', snapshotId: null, objectsAdded: 0, bytesWritten: 0, warnings: [], error: 'disk full' }, drive: null } }));
    h.getBackupSnapshots.mockResolvedValue([{ id: '20260912-020000', createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, counts: { files: 12, bytes: 5000 }, warnings: 0 }]);
    mount();
    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(await screen.findByText('20260912-020000')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download zip/i })).toHaveAttribute('href', expect.stringContaining('/api/backup/snapshots/20260912-020000/download'));
  });

  it('saves schedule and keep counts', async () => {
    mount();
    fireEvent.click(await screen.findByLabelText(/run every day/i));
    fireEvent.change(screen.getByLabelText(/keep local/i), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /save schedule/i }));
    await waitFor(() => expect(h.saveBackupSettings).toHaveBeenCalledWith({ schedule: { enabled: true, hour: 2, minute: 0 }, keep: { local: 30, drive: 14 } }));
  });

  // Regression: the local/Drive toggle changes only which list is fetched, and
  // useLiveQuery re-runs its loader on socket events and filter changes alone —
  // so the toggle has to refetch on its own or the Drive tab shows local rows.
  it('the Drive toggle refetches the snapshot list from Drive', async () => {
    mount();
    await waitFor(() => expect(h.getBackupSnapshots).toHaveBeenCalledWith('local'));
    fireEvent.click(screen.getByRole('button', { name: /drive/i }));
    await waitFor(() => expect(h.getBackupSnapshots).toHaveBeenCalledWith('drive'));
  });
});
