// src/pages/project/daily/DailyReportEditor.tsx
import React, { useEffect, useRef, useState } from 'react';
import { Camera, CloudSun, Plus, Trash2 } from 'lucide-react';
import {
  DailyReport, ManCountLine, DateTakenError,
  saveDailyReport, getDailyReport, addDailyReportPhoto, removeDailyReportPhoto, getDailyWeather,
  uploadProjectFile, getImageUrl, getSettings, getSmtpSettings, getAlwaysCc, getCustomer, getProject,
  fetchFileBlob, sendDailyReport,
} from '../../../utils/store';
import { Customer } from '../../../types';
import { resolveRecipient } from '../../../utils/recipients';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Textarea } from '../../../components/ui';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { formatReportDate, manCountTotal, normalizeManCounts } from './dailyReportForm';
import { buildDailyReportPdf, dailyReportFileName } from './dailyReportPdf';
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';

export const DailyReportEditor: React.FC<{
  report: DailyReport;
  projectId: string;
  projectName: string;
  contractor?: string | null;
  onClose: () => void;
  /** keepMounted: refresh the record without re-keying this editor — the
   *  document bar's save-then-generate flow dies if the modal remounts
   *  underneath it. */
  onSaved: (opts?: { keepMounted?: boolean }) => void;
}> = ({ report, projectId, projectName, onClose, onSaved }) => {
  const { toast } = useToast();
  const [reportDate, setReportDate] = useState(report.reportDate);
  const [jobName, setJobName] = useState(report.jobName ?? '');
  const [contractorName, setContractorName] = useState(report.contractorName ?? '');
  const [weatherSummary, setWeatherSummary] = useState(report.weatherSummary ?? '');
  const [temperature, setTemperature] = useState(report.temperature ?? '');
  const [weatherHourly, setWeatherHourly] = useState(report.weatherHourly ?? []);
  const [manCounts, setManCounts] = useState<ManCountLine[]>(report.manCounts ?? []);
  const [fieldNotes, setFieldNotes] = useState(report.fieldNotes ?? '');
  const [issues, setIssues] = useState(report.issues ?? '');
  const [saving, setSaving] = useState(false);
  const [fetchingWeather, setFetchingWeather] = useState(false);
  const [weatherNote, setWeatherNote] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const isDirty = () =>
    reportDate !== report.reportDate ||
    jobName.trim() !== (report.jobName ?? '') ||
    contractorName.trim() !== (report.contractorName ?? '') ||
    weatherSummary !== (report.weatherSummary ?? '') ||
    temperature !== (report.temperature ?? '') ||
    JSON.stringify(weatherHourly) !== JSON.stringify(report.weatherHourly ?? []) ||
    JSON.stringify(manCounts) !== JSON.stringify(report.manCounts ?? []) ||
    fieldNotes !== (report.fieldNotes ?? '') ||
    issues !== (report.issues ?? '');

  const dirty = isDirty();

  const collab = useCollabEditing({ type: 'dailyReport', id: report.id, isDirty, onFresh: onSaved });

  // Email defaults: resolved recipient, always-CC, header-email options.
  // recipients.ts has no 'dailyReport' template role — its TemplateType is a
  // fixed union, so we use the closest general fallback ('rfi', which maps to
  // the 'pm' role) rather than widen the union for one caller.
  const [emailDefaults, setEmailDefaults] = useState<{
    defaultTo: string;
    defaultCc: string;
    defaultBcc: string;
    companyEmail: string;
    headerEmailOptions: { label: string; value: string }[];
  }>({ defaultTo: '', defaultCc: '', defaultBcc: '', companyEmail: '', headerEmailOptions: [] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, smtp, alwaysCc, project] = await Promise.all([
          getSettings(),
          getSmtpSettings().catch(() => ({})),
          getAlwaysCc(),
          getProject(projectId).catch(() => null),
        ]);
        if (cancelled) return;
        let customer: Customer | undefined;
        if (project?.customerId) {
          customer = await getCustomer(project.customerId).catch(() => undefined);
        }
        const resolved = resolveRecipient('rfi', project?.contactEmails, customer?.emails);
        const mergeCsv = (...lists: string[]) => Array.from(new Set(lists.flatMap(s => (s || '').split(',').map(x => x.trim()).filter(Boolean)))).join(', ');
        const companyEmail = settings.companyEmail ?? '';
        const fromAddress = (smtp as { fromAddress?: string }).fromAddress ?? '';
        const opts = [
          companyEmail ? { label: 'Company default', value: companyEmail } : null,
          fromAddress && fromAddress !== companyEmail ? { label: 'My email', value: fromAddress } : null,
        ].filter(Boolean) as { label: string; value: string }[];
        if (!cancelled) {
          setEmailDefaults({ defaultTo: resolved.to, defaultCc: mergeCsv(resolved.cc, alwaysCc), defaultBcc: resolved.bcc, companyEmail, headerEmailOptions: opts });
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchWeather = async (opts?: { silent?: boolean }) => {
    setFetchingWeather(true);
    setWeatherNote(null);
    try {
      const w = await getDailyWeather(projectId, reportDate);
      setWeatherHourly(w.hourly);
      setWeatherSummary(w.summary);
      setTemperature(w.temperature);
    } catch (e) {
      if (e instanceof Error && e.message === 'no_address') {
        setWeatherNote('Add a project address to auto-fill weather.');
      } else if (!opts?.silent) {
        toast('Weather unavailable — enter it manually', { type: 'warning' });
      }
    } finally {
      setFetchingWeather(false);
    }
  };

  // Auto-fetch once for a brand-new report only — never clobber saved data
  // on reopen of an existing one.
  useEffect(() => {
    if (report.weatherHourly.length === 0 && report.version === 1) {
      fetchWeather({ silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateManCount = (i: number, patch: Partial<ManCountLine>) => {
    setManCounts(cur => cur.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  };
  const addManCountLine = () => setManCounts(cur => [...cur, { type: '', count: 1 }]);
  const removeManCountLine = (i: number) => setManCounts(cur => cur.filter((_, idx) => idx !== i));

  const handlePhotos = async (list: FileList | null) => {
    if (!list || !list.length) return;
    if (isDirty()) {
      toast('Save your changes first', { type: 'warning' });
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const { fileId } = await uploadProjectFile(projectId, f, 'daily-report-photo', { sourceType: 'dailyReport', sourceId: report.id });
        await addDailyReportPhoto(report.id, fileId);
        ok++;
      } catch { /* keep going */ }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} photos`, { type: ok ? 'warning' : 'error' });
    onSaved();
  };

  const dropPhoto = async (fileId: string) => {
    try { await removeDailyReportPhoto(report.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  // Built from the SAVED report, never the typed-in draft: the bar commits
  // first, so re-reading the record here is what keeps a generated report and
  // the report it claims to represent from drifting apart (photos included —
  // an upload that landed after this editor mounted is on the saved record,
  // not on the prop). A failed re-read throws on purpose — the bar then
  // reports the failure and keeps the existing document, rather than quietly
  // storing pre-save bytes and marking them current.
  const buildDailyReportBytes = async (headerEmail?: string): Promise<ArrayBuffer> => {
    const saved = await getDailyReport(report.id);
    if (!saved) throw new Error('Daily report not found');
    const settings = await getSettings();
    let logoDataUrl: string | undefined = settings.logoUrl || undefined;
    if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
      const blob = await (await fetch(logoDataUrl)).blob();
      logoDataUrl = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
    }
    if (logoDataUrl && settings.invertLogoOnDocuments === 'true') {
      logoDataUrl = await invertImageDataUrl(logoDataUrl);
    }
    // fetch each photo as a dataURL (authenticated content endpoint)
    const photoDataUrls: string[] = [];
    for (const p of saved.photos) {
      try {
        const blob = await fetchFileBlob(p.fileId);
        photoDataUrls.push(await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); }));
      } catch { /* skip */ }
    }
    return buildDailyReportPdf({
      report: saved,
      photoDataUrls,
      letterhead: {
        brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
        company: {
          name: settings.companyName || settings.appName,
          phone: settings.companyPhone,
          email: headerEmail ?? settings.companyEmail,
          address: settings.companyAddress,
        },
        logoDataUrl,
      },
      headerEmail: headerEmail || undefined,
    });
  };

  const handleSave = async (opts?: { keepMounted?: boolean }) => {
    // Thrown rather than returned so the document bar's save-first step can
    // tell a refused save from a successful one.
    setDateError(null);
    if (!reportDate) {
      setDateError('Enter a date for this report.');
      throw new Error('Enter a date for this report.');
    }
    setSaving(true);
    try {
      await saveDailyReport(report.id, {
        version: collab.keepMineVersion ?? report.version,
        reportDate,
        jobName: jobName.trim(),
        contractorName: contractorName.trim(),
        weatherSummary,
        temperature,
        weatherHourly,
        manCounts: normalizeManCounts(manCounts),
        fieldNotes,
        issues,
      });
      toast('Saved', { type: 'success' });
      // A "Keep mine" save adopted a foreign version number; only a remount
      // clears it, otherwise the next save would post a stale version.
      onSaved({ keepMounted: opts?.keepMounted === true && collab.keepMineVersion === null });
    } catch (e) {
      if (e instanceof DateTakenError) {
        setDateError('A report for this date already exists.');
      } else if (e instanceof Error && e.name === 'ConflictError') {
        toast('Report changed elsewhere — reopen it', { type: 'error' });
      } else {
        toast('Save failed', { type: 'error' });
      }
      throw e;
    } finally {
      setSaving(false);
    }
  };

  // The bar saves before it generates, so `false` here means "don't build".
  const saveForDocument = async (): Promise<boolean> => {
    try { await handleSave({ keepMounted: true }); return true; } catch { return false; }
  };

  return (
    <Modal open onClose={onClose} title={`Daily Report — ${formatReportDate(report.reportDate)}`} width="lg"
      footer={<>
        <div className="mr-auto">
          <DocumentActionsBar
            source={{ sourceType: 'dailyReport', sourceId: report.id }}
            kind="daily-report"
            format="pdf"
            projectId={projectId}
            fileName={dailyReportFileName(report, projectName)}
            build={async ({ headerEmail }) => new Blob([await buildDailyReportBytes(headerEmail)], { type: 'application/pdf' })}
            dirty={dirty}
            save={saveForDocument}
            updatedAt={report.updatedAt}
            size="sm"
            send={{
              composer: {
                title: 'Send daily report',
                defaultTo: emailDefaults.defaultTo || undefined,
                defaultCc: emailDefaults.defaultCc || undefined,
                defaultBcc: emailDefaults.defaultBcc || undefined,
                defaultSubject: `Daily Report — ${formatReportDate(report.reportDate)} — ${projectName}`,
                defaultBody: `Hello,\n\nPlease find attached the daily report for ${formatReportDate(report.reportDate)} on ${projectName}.\n\nThank you.`,
                headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                defaultHeaderEmail: emailDefaults.companyEmail || undefined,
              },
              sendFn: async (fileId, m) => {
                await sendDailyReport(report.id, {
                  to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body,
                  fileId, attachmentFileIds: m.attachmentFileIds,
                });
                onSaved({ keepMounted: true });
              },
            }}
          />
        </div>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={() => { void handleSave().catch(() => {}); }} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Job name" htmlFor="dr-job"><Input id="dr-job" value={jobName} onChange={e => setJobName(e.target.value)} /></Field>
        <Field label="Contractor" htmlFor="dr-contractor"><Input id="dr-contractor" value={contractorName} onChange={e => setContractorName(e.target.value)} /></Field>
        <Field label="Date" htmlFor="dr-date" error={dateError ?? undefined}>
          <Input id="dr-date" type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} />
        </Field>
      </div>

      <div className="mt-4 border-t border-edge pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Weather</h4>
          <Button variant="secondary" size="sm" onClick={() => fetchWeather()} disabled={fetchingWeather}>
            <CloudSun size={14} />{fetchingWeather ? 'Fetching…' : weatherHourly.length > 0 ? 'Refresh weather' : 'Fetch weather'}
          </Button>
        </div>
        {weatherNote && <p className="mb-2 text-xs text-ink-faint">{weatherNote}</p>}
        {weatherHourly.length > 0 && (
          <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
            {weatherHourly.map((h, i) => (
              <div key={i} className="flex shrink-0 flex-col items-center rounded-md border border-edge px-2 py-1 text-xs">
                <span className="text-ink-faint">{h.hour}</span>
                <span className="font-medium text-ink">{h.tempF != null ? `${h.tempF}°` : '—'}</span>
                <span className="text-ink-faint">{h.condition}</span>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Weather" htmlFor="dr-weather-summary"><Input id="dr-weather-summary" value={weatherSummary} onChange={e => setWeatherSummary(e.target.value)} /></Field>
          <Field label="Temperature" htmlFor="dr-temp"><Input id="dr-temp" value={temperature} onChange={e => setTemperature(e.target.value)} /></Field>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-edge pt-3 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-sm font-semibold text-ink">Man count</h4>
          <div className="space-y-2">
            {manCounts.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Input value={l.type} onChange={e => updateManCount(i, { type: e.target.value })} placeholder="Trade / role" />
                </div>
                {/* Wrapper (not className) constrains the width: the Input base
                    classes start with w-full, which in this flex row out-muscled
                    a passed w-20 and made the count box the WIDE one. */}
                <div className="w-20 flex-none">
                  <Input type="number" min={0} value={l.count} onChange={e => updateManCount(i, { count: Number(e.target.value) })} />
                </div>
                <button onClick={() => removeManCountLine(i)} title="Remove" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <Button variant="secondary" size="sm" className="mt-2" onClick={addManCountLine}><Plus size={14} />Add line</Button>
          <p className="mt-2 text-xs text-ink-faint">Total: {manCountTotal(normalizeManCounts(manCounts))} men</p>
        </div>
        <Field label="Field notes" htmlFor="dr-notes">
          <Textarea id="dr-notes" value={fieldNotes} onChange={e => setFieldNotes(e.target.value)} rows={10} />
        </Field>
      </div>

      <div className="mt-4 border-t border-edge pt-3">
        <Field label="Issues" htmlFor="dr-issues">
          <Textarea id="dr-issues" value={issues} onChange={e => setIssues(e.target.value)} rows={3} />
        </Field>
      </div>

      <div className="mt-4 border-t border-edge pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Photos</h4>
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Camera size={14} />{uploading ? 'Uploading…' : 'Add photos'}
          </Button>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
            onChange={e => handlePhotos(e.target.files)} />
        </div>
        {report.photos.length === 0 ? (
          <p className="text-xs text-ink-faint">No photos. Add before/during/after shots from the field.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {report.photos.map(p => (
              <div key={p.id} className="group relative">
                <img src={getImageUrl(p.fileId)} alt="" className="h-24 w-full rounded-lg border border-edge object-cover" />
                <button onClick={() => dropPhoto(p.fileId)} title="Remove"
                  className="absolute right-1 top-1 flex min-h-9 min-w-9 items-center justify-center rounded-md bg-black/50 p-1 text-white opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

    </Modal>
  );
};
