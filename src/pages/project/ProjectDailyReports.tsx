// src/pages/project/ProjectDailyReports.tsx
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CalendarDays, Plus, Trash2, ImageIcon } from 'lucide-react';
import {
  DailyReport, DailyReportListItem, ManCountLine, DateTakenError,
  getDailyReports, getDailyReport, createDailyReport, deleteDailyReport,
  getProject, getSettings,
} from '../../utils/store';
import { useProjectOutlet } from './ProjectLayout';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import {
  Button, Card, CardBody, EmptyState, Field, Input, Skeleton, Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';
import { EditingChip } from '../../components/EditingChip';
import { DailyReportEditor } from './daily/DailyReportEditor';

export const manCountTotal = (lines: ManCountLine[]): number =>
  lines.reduce((s, l) => s + (Number.isFinite(l.count) && l.count > 0 ? l.count : 0), 0);

export const formatReportDate = (d: string): string => {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return d;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const ProjectDailyReports: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { summary } = useProjectOutlet();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [reports, setReports] = useState<DailyReportListItem[] | null>(null);
  const [editing, setEditing] = useState<DailyReport | null>(null);
  const [reportDate, setReportDate] = useState(() => new Date().toLocaleDateString('en-CA'));
  const [creating, setCreating] = useState(false);

  const load = () => {
    if (!projectId) return;
    getDailyReports(projectId).then(setReports).catch(() => setReports([]));
  };
  useLiveQuery(load, { types: ['dailyReport'], projectId });

  // Focus the create-form input when arriving via the command palette's "New daily report" action.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      const el = document.getElementById('new-daily-report-date') as HTMLInputElement | null;
      if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('new'); return p; }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const openReport = async (id: string) => {
    try { setEditing(await getDailyReport(id)); } catch { toast('Failed to open report', { type: 'error' }); }
  };

  // Prefill source for a new report's contractor name: the project summary
  // first, else the full project record, else the company name from
  // settings — settings is only fetched if the earlier sources come up empty.
  const resolveContractorName = async (): Promise<string> => {
    if (summary?.contractor) return summary.contractor;
    if (projectId) {
      try {
        const project = await getProject(projectId);
        if (project?.contractor) return project.contractor;
      } catch { /* fall through to settings */ }
    }
    try {
      const settings = await getSettings();
      return settings.companyName ?? '';
    } catch { return ''; }
  };

  const addReport = async () => {
    if (!projectId || !reportDate) { toast('Pick a date', { type: 'warning' }); return; }
    setCreating(true);
    try {
      const contractorName = await resolveContractorName();
      const r = await createDailyReport(projectId, { reportDate, jobName: summary?.name ?? '', contractorName });
      setEditing(await getDailyReport(r.id));
      load();
    } catch (e) {
      if (e instanceof DateTakenError) {
        await openReport(e.existingId);
      } else {
        toast('Failed to create report', { type: 'error' });
      }
    } finally {
      setCreating(false);
    }
  };

  const removeReport = async (id: string) => {
    if (!(await confirm({ title: 'Delete daily report?', message: 'This permanently removes the report.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteDailyReport(id); load(); } catch { toast('Delete failed', { type: 'error' }); }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <h1 className="mb-4 text-xl font-bold text-ink">Daily Reports</h1>

      <Card className="mb-5">
        <CardBody>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="New report" htmlFor="new-daily-report-date">
              <Input id="new-daily-report-date" type="date" value={reportDate} onChange={e => setReportDate(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addReport(); }}
                className="w-full sm:w-auto" />
            </Field>
            <Button onClick={addReport} disabled={creating}><Plus size={15} />New report</Button>
          </div>
        </CardBody>
      </Card>

      {reports === null ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : reports.length === 0 ? (
        <EmptyState icon={<CalendarDays size={22} />} title="No daily reports yet"
          description="Log crew counts, weather, and field notes for each day on site — attach photos and send a branded PDF." />
      ) : (
        <Table>
          <THead><TR><TH>Date</TH><TH>Crew</TH><TH>Weather</TH><TH>Photos</TH><TH></TH></TR></THead>
          <TBody>
            {reports.map(r => (
              <TR key={r.id} interactive onClick={() => openReport(r.id)}>
                <TD className="font-medium text-ink"><span className="inline-flex items-center gap-1.5">{formatReportDate(r.reportDate)}<EditingChip type="dailyReport" id={r.id} /></span></TD>
                <TD className="text-ink-soft">{manCountTotal(r.manCounts) > 0 ? `${manCountTotal(r.manCounts)} men` : '—'}</TD>
                <TD className="max-w-[16rem] truncate text-ink-soft">{[r.weatherSummary, r.temperature].filter(Boolean).join(' ') || '—'}</TD>
                <TD className="text-ink-soft">{r.photoCount > 0 ? <span className="inline-flex items-center gap-1"><ImageIcon size={13} />{r.photoCount}</span> : '—'}</TD>
                <TD onClick={e => e.stopPropagation()}>
                  <button onClick={() => removeReport(r.id)} title="Delete" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {editing && (
        <DailyReportEditor
          key={`${editing.id}:${editing.version}`}
          report={editing}
          projectId={projectId ?? ''}
          projectName={summary?.name ?? ''}
          contractor={summary?.contractor}
          onClose={() => setEditing(null)}
          onSaved={() => { load(); openReport(editing.id); }}
        />
      )}
    </div>
  );
};
