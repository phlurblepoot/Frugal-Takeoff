// src/pages/settings/BackupTab.tsx — Settings → Backup (admin only).
//
// The whole point of this screen is to answer one question at a glance: is
// there a backup, and is it recent? So the status card leads with the last
// local and Drive runs (with their error text when they failed) rather than
// with the controls, and a backup root that still sits on the data volume is
// called out in amber — copying the data onto the same disk is not a backup.
//
// Connect / Reconnect are real <a href> links, not buttons that assign
// window.location: the Drive start route answers with a 302 to Google, so a
// link is the honest element for it (middle-click, "copy link") and it keeps
// the redirect testable without jsdom navigation. Same for the snapshot
// download, which streams a zip the browser saves itself.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Cloud, DatabaseBackup, Download, HardDrive, Play, RefreshCw, Save } from 'lucide-react';
import {
  Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Select, Skeleton, StatusPill,
  Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import {
  BackupRunningError, backupDownloadUrl, backupDriveStartUrl, disconnectBackupDrive, formatBytes,
  getBackupRuns, getBackupSnapshots, getBackupStatus, runBackup, saveBackupSettings,
  type BackupRun, type BackupSnapshot, type BackupStatus,
} from '../../utils/store';

type Target = 'local' | 'drive';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong');
const when = (ms: number | null | undefined): string => (ms ? new Date(ms).toLocaleString() : '—');

// This project compiles without strictNullChecks, where TypeScript will not
// narrow the *not-connected* half of a `connected: true | false` union on its
// own. A type predicate does narrow both halves, so the Drive card can read
// `email` and `configurable` off the right variant without a cast.
type DriveState = BackupStatus['drive'];
type DriveConnected = Extract<DriveState, { connected: true }>;
const isDriveConnected = (d: DriveState): d is DriveConnected => d.connected;

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 15, 30, 45];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** One finished run, as it reads on the status card. A failure shows its error
 *  text verbatim — it is usually the whole diagnosis ("disk full"). */
const LastRunLine: React.FC<{ label: string; run: BackupRun | null }> = ({ label, run }) => (
  <div className="flex flex-wrap items-center gap-2 text-sm">
    <span className="w-24 shrink-0 text-ink-soft">{label}</span>
    {!run ? (
      <span className="text-ink-faint">Never run</span>
    ) : (
      <>
        <StatusPill tone={run.status === 'ok' ? 'green' : 'red'}>{run.status === 'ok' ? 'OK' : 'Failed'}</StatusPill>
        <span className="text-ink">{when(run.finishedAt ?? run.startedAt)}</span>
        {run.status === 'ok' && (
          <span className="text-ink-soft">
            {run.objectsAdded.toLocaleString()} new file{run.objectsAdded === 1 ? '' : 's'} · {formatBytes(run.bytesWritten)}
          </span>
        )}
        {run.error && <span className="text-red-600 dark:text-red-400">{run.error}</span>}
      </>
    )}
  </div>
);

export const BackupTab: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [snapshots, setSnapshots] = useState<BackupSnapshot[]>([]);
  const [runs, setRuns] = useState<BackupRun[] | null>(null);
  const [view, setView] = useState<Target>('local');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  // Draft copies of the settings. They are adopted from the server on every
  // load until the user touches the form — a live reload landing mid-edit must
  // not silently undo what they just typed.
  const [schedule, setSchedule] = useState<BackupStatus['schedule']>({ enabled: false, hour: 2, minute: 0 });
  const [keep, setKeep] = useState<BackupStatus['keep']>({ local: 14, drive: 14 });
  const formDirty = useRef(false);

  // Read through a ref so `load` stays identity-stable: useLiveQuery only
  // re-runs its initial load when the *filter* changes, so a `load` that
  // changed with the toggle would never be called again anyway.
  const viewRef = useRef(view);
  viewRef.current = view;

  const load = useCallback(async () => {
    try {
      const [s, snaps] = await Promise.all([
        getBackupStatus(),
        // A snapshot list can fail on its own (Drive unreachable) without
        // taking the status card down with it.
        getBackupSnapshots(viewRef.current).catch(() => [] as BackupSnapshot[]),
      ]);
      setStatus(s);
      if (!formDirty.current) { setSchedule(s.schedule); setKeep(s.keep); }
      setSnapshots(snaps);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  // Initial load, plus a reload whenever the server finishes a run.
  useLiveQuery(load, { types: ['backupRun'] });

  // The local/Drive toggle changes only which list to show, so it refetches
  // the list alone. The first run is skipped: useLiveQuery just loaded both.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    let cancelled = false;
    getBackupSnapshots(view)
      .then(s => { if (!cancelled) setSnapshots(s); })
      .catch(() => { if (!cancelled) setSnapshots([]); });
    return () => { cancelled = true; };
  }, [view]);

  // The Drive OAuth callback lands back here as /settings?tab=backup&drive=connected
  // (or &error=…). Read it off the URL and clear it so a reload is not a rerun
  // of the toast. window.location rather than useSearchParams: this tab is
  // mounted directly in its own tests, outside a Router.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('drive');
    const failed = params.get('error');
    if (!connected && !failed) return;
    if (failed) toast(failed, { type: 'error' });
    else if (connected === 'connected') toast('Google Drive connected.', { type: 'success' });
    params.delete('drive');
    params.delete('error');
    const q = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash}`);
  }, [toast]);

  const start = async (target: Target) => {
    setBusy(true);
    try {
      await runBackup(target);
      toast(target === 'local' ? 'Backup started.' : 'Drive backup started.', { type: 'success' });
      await load();
    } catch (e) {
      toast(e instanceof BackupRunningError ? 'A backup is already running' : errText(e), { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      await saveBackupSettings({ schedule, keep });
      formDirty.current = false;
      toast('Backup schedule saved.', { type: 'success' });
      await load();
    } catch (e) {
      toast(errText(e), { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Disconnect Google Drive?',
      message: 'Backups stop copying off-site. Snapshots already in Drive are left alone.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await disconnectBackupDrive();
      toast('Google Drive disconnected.', { type: 'success' });
      await load();
    } catch (e) {
      toast(errText(e), { type: 'error' });
    }
  };

  // Refetched on every open rather than cached: the list is only interesting
  // right after a run, which is exactly when a cached copy would be stale.
  const openRuns = async (open: boolean) => {
    if (!open) return;
    try { setRuns(await getBackupRuns()); } catch { setRuns([]); }
  };

  if (error && !status) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <Button className="mt-4" variant="secondary" onClick={() => void load()}><RefreshCw size={15} /> Retry</Button>
        </CardBody>
      </Card>
    );
  }

  if (!status) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  const running = status.running;
  // Pulled out so the connected/not-connected union narrows once for the whole
  // Drive card (TS will not narrow a nested `status.drive.*` path across JSX).
  const drive = status.drive;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><DatabaseBackup size={18} className="text-accent-600" /> Backups</span>}
          actions={
            <button onClick={() => void load()} title="Refresh" className="rounded-lg p-2 text-ink-faint transition-colors hover:bg-hover hover:text-accent-600">
              <RefreshCw size={16} />
            </button>
          }
        />
        <CardBody className="space-y-4">
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div>
            <p className="text-sm text-ink-soft">Every backup writes to</p>
            <code className="mt-1 block break-all font-mono text-sm text-ink">{status.root}</code>
            {status.rootIsDefault && (
              <p className="mt-2 flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>Backups are on the same disk as the data. Set BACKUP_PATH to a different volume.</span>
              </p>
            )}
          </div>

          <div className="space-y-1.5 border-t border-edge pt-4">
            <LastRunLine label="Last local" run={status.lastRun.local} />
            <LastRunLine label="Last Drive" run={status.lastRun.drive} />
          </div>

          <div className="grid grid-cols-1 gap-3 border-t border-edge pt-4 sm:grid-cols-3">
            <div className="rounded-lg bg-sunken/50 p-3">
              <div className="text-xl font-semibold text-ink">{status.totals.snapshots.toLocaleString()}</div>
              <div className="mt-0.5 text-xs uppercase tracking-wider text-ink-soft">Snapshots</div>
            </div>
            <div className="rounded-lg bg-sunken/50 p-3">
              <div className="text-xl font-semibold text-ink">{status.totals.objects.toLocaleString()}</div>
              <div className="mt-0.5 text-xs uppercase tracking-wider text-ink-soft">Stored objects</div>
            </div>
            <div className="rounded-lg bg-sunken/50 p-3">
              <div className="text-xl font-semibold text-ink">{formatBytes(status.totals.bytes)}</div>
              <div className="mt-0.5 text-xs uppercase tracking-wider text-ink-soft">Latest snapshot</div>
            </div>
          </div>

          <p className="text-sm text-ink-soft">
            Next scheduled run: <span className="text-ink">{status.nextRunAt ? when(status.nextRunAt) : 'Not scheduled'}</span>
          </p>

          {running && (
            <p className="flex items-center gap-2 text-sm text-accent-700 dark:text-accent-300">
              <RefreshCw size={15} className="animate-spin" /> Backing up… ({running.target})
            </p>
          )}

          <div className="flex flex-wrap gap-2 border-t border-edge pt-4">
            <Button disabled={busy || !!running} onClick={() => void start('local')}>
              <Play size={15} /> Back up now
            </Button>
            {isDriveConnected(drive) && (
              <Button variant="secondary" disabled={busy || !!running} onClick={() => void start('drive')}>
                <Cloud size={15} /> Back up to Drive now
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Cloud size={18} className="text-accent-600" /> Off-site copy</span>} />
        <CardBody className="space-y-3">
          {isDriveConnected(drive) ? (
            <>
              <p className="text-sm text-ink">Connected as {drive.email}</p>
              {drive.needsReconnect && (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  Google stopped accepting this connection.{' '}
                  <a href={backupDriveStartUrl()} className="font-medium underline">Reconnect</a>
                </p>
              )}
              <Button variant="secondary" onClick={() => void disconnect()}>Disconnect</Button>
            </>
          ) : drive.configurable ? (
            <>
              <p className="text-sm text-ink-soft">
                A copy in Google Drive survives the server itself — a failed disk, a lost machine, a bad restore.
              </p>
              <a
                href={backupDriveStartUrl()}
                className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-edge bg-raised px-4 text-sm font-medium text-ink transition-colors hover:bg-hover md:h-9 md:min-h-0"
              >
                <Cloud size={15} /> Connect Google Drive
              </a>
            </>
          ) : (
            <p className="text-sm text-ink-soft">Set GOOGLE_OAUTH_CLIENT_ID / SECRET and APP_PUBLIC_URL to enable Drive</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Schedule &amp; retention" />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox
              label="Run every day at"
              checked={schedule.enabled}
              onChange={e => { formDirty.current = true; setSchedule(s => ({ ...s, enabled: e.target.checked })); }}
            />
            <Select
              aria-label="Hour"
              className="w-auto"
              value={String(schedule.hour)}
              onChange={e => { formDirty.current = true; setSchedule(s => ({ ...s, hour: Number(e.target.value) })); }}
            >
              {HOURS.map(h => <option key={h} value={h}>{pad2(h)}</option>)}
            </Select>
            <span className="text-ink-soft">:</span>
            <Select
              aria-label="Minute"
              className="w-auto"
              value={String(schedule.minute)}
              onChange={e => { formDirty.current = true; setSchedule(s => ({ ...s, minute: Number(e.target.value) })); }}
            >
              {MINUTES.map(m => <option key={m} value={m}>{pad2(m)}</option>)}
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Keep local snapshots" htmlFor="backup-keep-local" hint="Older local snapshots are pruned after each run.">
              <Input
                id="backup-keep-local"
                type="number"
                min={1}
                value={keep.local}
                onChange={e => { formDirty.current = true; setKeep(k => ({ ...k, local: Number(e.target.value) })); }}
              />
            </Field>
            <Field label="Keep Drive snapshots" htmlFor="backup-keep-drive" hint="Applies to the copies in Google Drive.">
              <Input
                id="backup-keep-drive"
                type="number"
                min={1}
                value={keep.drive}
                onChange={e => { formDirty.current = true; setKeep(k => ({ ...k, drive: Number(e.target.value) })); }}
              />
            </Field>
          </div>

          <Button disabled={saving} onClick={() => void saveSettings()}>
            <Save size={15} /> Save schedule
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Snapshots"
          actions={
            <div className="inline-flex overflow-hidden rounded-lg border border-edge" role="group" aria-label="Snapshot source">
              {(['local', 'drive'] as Target[]).map(t => (
                <button
                  key={t}
                  onClick={() => setView(t)}
                  aria-pressed={view === t}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    view === t ? 'bg-accent-600 text-white' : 'bg-raised text-ink-soft hover:bg-hover'
                  }`}
                >
                  {t === 'local' ? <span className="flex items-center gap-1"><HardDrive size={13} /> Local</span>
                                 : <span className="flex items-center gap-1"><Cloud size={13} /> Drive</span>}
                </button>
              ))}
            </div>
          }
        />
        <CardBody className="p-0">
          {snapshots.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-faint">
              No {view === 'local' ? 'local' : 'Drive'} snapshots yet.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Version</TH>
                  <TH>Files</TH>
                  <TH>Size</TH>
                  <TH>Warnings</TH>
                  <TH><span className="sr-only">Download</span></TH>
                </TR>
              </THead>
              <TBody>
                {snapshots.map(s => (
                  <TR key={s.id}>
                    <TD className="font-mono">{s.id}</TD>
                    <TD>{s.appVersion}</TD>
                    <TD>{s.counts.files.toLocaleString()}</TD>
                    <TD>{formatBytes(s.counts.bytes)}</TD>
                    <TD>{s.warnings > 0 ? <StatusPill tone="amber">{s.warnings}</StatusPill> : <span className="text-ink-faint">0</span>}</TD>
                    <TD>
                      {view === 'local' && (
                        <a href={backupDownloadUrl(s.id)} download className="inline-flex items-center gap-1 text-sm font-medium text-accent-600 hover:underline">
                          <Download size={14} /> Download zip
                        </a>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <details className="rounded-xl border border-edge bg-raised" onToggle={e => void openRuns((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-ink">Run history</summary>
        <div className="border-t border-edge px-5 py-4">
          {runs === null ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-ink-faint">No runs recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {runs.map(r => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusPill tone={r.status === 'ok' ? 'green' : r.status === 'running' ? 'blue' : 'red'}>{r.status}</StatusPill>
                  <span className="text-ink">{when(r.startedAt)}</span>
                  <span className="text-ink-soft">{r.target} · {r.trigger}</span>
                  {r.status === 'ok' && <span className="text-ink-soft">{formatBytes(r.bytesWritten)}</span>}
                  {r.error && <span className="text-red-600 dark:text-red-400">{r.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <p className="text-xs text-ink-faint">
        Restore is only offered on a fresh install — see the login page of an empty server.
      </p>
    </div>
  );
};
